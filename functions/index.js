'use strict'

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { onDocumentWritten } = require('firebase-functions/v2/firestore')
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')

const {
  sanitizeReading,
  sanitizeListening,
  sanitizeVocabulary,
  gradeReading,
  gradeListening,
  gradeVocabulary,
  gradeMock,
  getMockEnabledSections,
  getMockWritingMode
} = require('./lib/grading')

initializeApp()
const db = getFirestore()

const OBJECTIVE_CONFIG = {
  reading: {
    contentType: 'reading',
    sourceCollection: 'readings',
    publicCollection: 'studentReadings',
    submissionCollection: 'readingSubmissions',
    parentField: 'readingId',
    sanitizer: sanitizeReading
  },
  listening: {
    contentType: 'listening',
    sourceCollection: 'listenings',
    publicCollection: 'studentListenings',
    submissionCollection: 'listeningSubmissions',
    parentField: 'listeningId',
    sanitizer: sanitizeListening
  },
  vocabulary: {
    contentType: 'vocabulary',
    sourceCollection: 'vocabularyTests',
    publicCollection: 'studentVocabularyTests',
    submissionCollection: 'vocabularySubmissions',
    parentField: 'vocabularyTestId',
    sanitizer: sanitizeVocabulary
  }
}

const ACCESS_CONTENT_CONFIG = {
  reading: OBJECTIVE_CONFIG.reading,
  listening: OBJECTIVE_CONFIG.listening,
  vocabulary: OBJECTIVE_CONFIG.vocabulary,
  writing: {
    contentType: 'writing',
    sourceCollection: 'writingHomeworks'
  },
  mock: {
    contentType: 'mock',
    sourceCollection: 'mockTests'
  }
}

function asString(value) {
  return value === undefined || value === null ? '' : value.toString()
}

function uniqueStrings(values) {
  return Array.from(new Set(
    (values || [])
      .filter(value => value !== undefined && value !== null)
      .map(value => value.toString().trim())
      .filter(Boolean)
  ))
}

function schoolIdOf(data) {
  return data?.schoolId || 'maxima'
}

function teacherIdsOf(data) {
  const explicit = Array.isArray(data?.teacherIds) ? data.teacherIds : []
  if (explicit.length) return uniqueStrings(explicit)
  return uniqueStrings([data?.teacherId, data?.createdBy])
}

function assignmentValues(data) {
  return uniqueStrings([
    ...(Array.isArray(data?.assignTo) ? data.assignTo : []),
    ...(Array.isArray(data?.assignedTo) ? data.assignedTo : []),
    ...(Array.isArray(data?.studentIds) ? data.studentIds : []),
    ...(Array.isArray(data?.assignedStudentIds) ? data.assignedStudentIds : []),
    ...(Array.isArray(data?.assignedEmails) ? data.assignedEmails : [])
  ]).map(value => value.toLowerCase())
}

const STUDENT_ACCESS_SCHEMA_VERSION = 1
const REVIEW_POLICIES = new Set(['immediate', 'teacher_release', 'scheduled', 'never'])

function looksLikeEmail(value) {
  return typeof value === 'string' && value.includes('@')
}

function assignedUidValues(data) {
  const explicit = uniqueStrings([
    ...(Array.isArray(data?.studentIds) ? data.studentIds : []),
    ...(Array.isArray(data?.assignedStudentIds) ? data.assignedStudentIds : [])
  ])

  const compatible = uniqueStrings([
    ...(Array.isArray(data?.assignTo) ? data.assignTo : []),
    ...(Array.isArray(data?.assignedTo) ? data.assignedTo : [])
  ]).filter(value => !looksLikeEmail(value))

  return uniqueStrings([...explicit, ...compatible])
}

function hiddenUidValues(data) {
  return uniqueStrings(Array.isArray(data?.hiddenFor) ? data.hiddenFor : [])
    .filter(value => !looksLikeEmail(value))
}

function hasAnyAssignmentSignal(data) {
  return assignmentValues(data).length > 0
}

function studentAccessId(uid, contentType, contentId) {
  return `${uid}_${contentType}_${contentId}`
}

function reviewPolicyOf(data) {
  const value = typeof data?.reviewPolicy === 'string'
    ? data.reviewPolicy.trim()
    : ''
  return REVIEW_POLICIES.has(value) ? value : 'immediate'
}

function studentAccessPayload(contentType, sourceCollection, contentId, source, uid) {
  const teacherIds = teacherIdsOf(source)
  const hidden = hiddenUidValues(source).includes(uid)

  return {
    uid,
    schoolId: schoolIdOf(source),
    contentType,
    contentId,
    sourceCollection,
    accessType: 'assignment',
    status: source?.archived === true || hidden ? 'inactive' : 'active',
    assignedBy: teacherIds[0] || '',
    reviewPolicy: reviewPolicyOf(source),
    reviewReleaseAt: source?.reviewReleaseAt ?? null,
    dueAt: source?.dueAt ?? source?.dueDate ?? null,
    schemaVersion: STUDENT_ACCESS_SCHEMA_VERSION,
    updatedAt: FieldValue.serverTimestamp()
  }
}

async function syncStudentAccessChange({
  contentType,
  sourceCollection,
  contentId,
  beforeSource,
  afterSource
}) {
  if (!contentId) return

  const beforeUids = assignedUidValues(beforeSource)
  const afterUids = assignedUidValues(afterSource)
  const beforeSet = new Set(beforeUids)
  const afterSet = new Set(afterUids)

  // If a legacy record contains only email-based assignment values, do not
  // infer removals here. Stage 16E backfill resolves those records safely.
  const afterHasUnresolvedLegacyAssignment =
    Boolean(afterSource) &&
    hasAnyAssignmentSignal(afterSource) &&
    afterUids.length === 0

  const batch = db.batch()
  let writes = 0

  if (afterSource) {
    for (const uid of afterUids) {
      const ref = db.doc(`studentAccess/${studentAccessId(uid, contentType, contentId)}`)
      const payload = studentAccessPayload(
        contentType,
        sourceCollection,
        contentId,
        afterSource,
        uid
      )

      if (!beforeSet.has(uid)) {
        payload.assignedAt = FieldValue.serverTimestamp()
      }

      batch.set(ref, payload, { merge: true })
      writes++
    }
  }

  if (!afterHasUnresolvedLegacyAssignment) {
    for (const uid of beforeUids) {
      if (afterSet.has(uid)) continue
      const ref = db.doc(`studentAccess/${studentAccessId(uid, contentType, contentId)}`)
      batch.delete(ref)
      writes++
    }
  } else {
    console.warn(
      `Skipped studentAccess removals for ${sourceCollection}/${contentId}: ` +
      'legacy email-only assignments need Stage 16E resolution.'
    )
  }

  if (writes > 0) {
    await batch.commit()
  }
}

async function syncStudentAccessWrite(event, contentType, sourceCollection) {
  const id = event.params?.id
  if (!id) return

  const before = event.data?.before
  const after = event.data?.after
  const beforeSource = before?.exists ? (before.data() || {}) : null
  const afterSource = after?.exists ? (after.data() || {}) : null

  await syncStudentAccessChange({
    contentType,
    sourceCollection,
    contentId: id,
    beforeSource,
    afterSource
  })
}

function toPlain(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(toPlain)
  if (value instanceof Date) return value.toISOString()
  if (typeof value?.toDate === 'function') return value.toDate().toISOString()
  if (typeof value !== 'object') return value

  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = toPlain(item)
  }
  return output
}

function assertJsonSize(value, label, maxBytes) {
  let json = ''
  try {
    json = JSON.stringify(value)
  } catch {
    throw new HttpsError('invalid-argument', `${label} could not be serialized.`)
  }

  if (json === undefined || Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new HttpsError('invalid-argument', `${label} is too large.`)
  }
}

function assertSmallPlainObject(value, label, maxBytes = 500000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpsError('invalid-argument', `${label} must be an object.`)
  }

  assertJsonSize(value, label, maxBytes)
}

function safePlainObject(value, label, maxBytes = 50000) {
  if (value === undefined || value === null) return {}
  assertSmallPlainObject(value, label, maxBytes)
  return value
}

function safeJsonArray(value, label, maxItems = 500, maxBytes = 150000) {
  if (!Array.isArray(value)) return []
  const output = value.slice(0, maxItems)
  assertJsonSize(output, label, maxBytes)
  return output
}

function assertDocumentId(value, label = 'Homework ID') {
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', `${label} is required.`)
  }

  const id = value.trim()
  if (!id || id.includes('/') || Buffer.byteLength(id, 'utf8') > 1500) {
    throw new HttpsError('invalid-argument', `Invalid ${label.toLowerCase()}.`)
  }

  return id
}

function objectiveConfigFor(type) {
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(OBJECTIVE_CONFIG, type)) {
    throw new HttpsError('invalid-argument', 'Unsupported review type.')
  }
  return OBJECTIVE_CONFIG[type]
}

function safeString(value, maxLength = 5000) {
  return asString(value).slice(0, maxLength)
}

function safeStringArray(value, maxItems = 300, maxLength = 250) {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, maxItems)
    .map(item => safeString(item, maxLength))
    .filter(Boolean)
}

async function requireStudent(request) {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Please sign in again.')
  }

  const uid = request.auth.uid
  const userSnap = await db.doc(`users/${uid}`).get()
  if (!userSnap.exists) {
    throw new HttpsError('permission-denied', 'Student profile was not found.')
  }

  const profile = userSnap.data() || {}
  if (profile.role !== 'student' || profile.status !== 'approved' || profile.deleted === true) {
    throw new HttpsError('permission-denied', 'This account cannot submit student work.')
  }

  return {
    uid,
    email: request.auth.token?.email || profile.email || '',
    profile
  }
}

function accessContentConfigFor(type) {
  const key = typeof type === 'string' ? type.trim() : ''
  const config = ACCESS_CONTENT_CONFIG[key]
  if (!config) {
    throw new HttpsError('invalid-argument', 'Unsupported content type.')
  }
  return {
    contentType: config.contentType,
    sourceCollection: config.sourceCollection
  }
}

async function requireAssignmentManager(request) {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Please sign in again.')
  }

  const uid = request.auth.uid
  const userSnap = await db.doc(`users/${uid}`).get()
  if (!userSnap.exists) {
    throw new HttpsError('permission-denied', 'Staff profile was not found.')
  }

  const profile = userSnap.data() || {}
  const allowedRole = profile.role === 'teacher' || profile.role === 'admin'
  if (!allowedRole || profile.status !== 'approved' || profile.deleted === true) {
    throw new HttpsError('permission-denied', 'This account cannot manage assignments.')
  }

  return { uid, profile }
}

function assertStudentUidList(value) {
  if (!Array.isArray(value)) {
    throw new HttpsError('invalid-argument', 'Student IDs must be an array.')
  }
  if (value.length > 250) {
    throw new HttpsError('invalid-argument', 'Too many students were selected at once.')
  }

  return uniqueStrings(value).map(uid => assertDocumentId(uid, 'Student ID'))
}

function managerCanManageSource(manager, source) {
  if (manager.profile.role === 'admin') return true
  return schoolIdOf(source) === schoolIdOf(manager.profile)
    && teacherIdsOf(source).includes(manager.uid)
}

async function loadAssignableStudents(studentIds, schoolId) {
  if (studentIds.length === 0) return []

  const refs = studentIds.map(uid => db.doc(`users/${uid}`))
  const snaps = await db.getAll(...refs)
  const students = []

  for (let index = 0; index < snaps.length; index++) {
    const snap = snaps[index]
    const uid = studentIds[index]
    if (!snap.exists) {
      throw new HttpsError('failed-precondition', `Student ${uid} no longer exists.`)
    }

    const profile = snap.data() || {}
    if (
      profile.role !== 'student' ||
      profile.status !== 'approved' ||
      profile.deleted === true ||
      schoolIdOf(profile) !== schoolId
    ) {
      throw new HttpsError(
        'failed-precondition',
        `Student ${uid} is not an active student in this school.`
      )
    }

    students.push({ uid, profile })
  }

  return students
}

async function commitAccessOperations(operations) {
  const chunkSize = 400
  for (let start = 0; start < operations.length; start += chunkSize) {
    const batch = db.batch()
    for (const operation of operations.slice(start, start + chunkSize)) {
      if (operation.type === 'delete') {
        batch.delete(operation.ref)
      } else {
        batch.set(operation.ref, operation.data, { merge: true })
      }
    }
    await batch.commit()
  }
}

async function requireActiveStudentAccess({
  student,
  contentType,
  contentId,
  sourceCollection
}) {
  const ref = db.doc(`studentAccess/${studentAccessId(student.uid, contentType, contentId)}`)
  const snap = await ref.get()

  if (!snap.exists) {
    throw new HttpsError('permission-denied', 'This homework is not assigned to you.')
  }

  const access = snap.data() || {}
  if (
    access.uid !== student.uid ||
    access.contentType !== contentType ||
    access.contentId !== contentId ||
    access.sourceCollection !== sourceCollection ||
    access.status !== 'active' ||
    schoolIdOf(access) !== schoolIdOf(student.profile)
  ) {
    throw new HttpsError('permission-denied', 'This homework is no longer available.')
  }

  return access
}

async function requireAvailableStudentSource({
  source,
  student,
  contentType,
  contentId,
  sourceCollection
}) {
  if (!source) throw new HttpsError('not-found', 'Homework was not found.')

  const access = await requireActiveStudentAccess({
    student,
    contentType,
    contentId,
    sourceCollection
  })

  if (source.archived === true) {
    throw new HttpsError('permission-denied', 'This homework is no longer available.')
  }

  if (
    schoolIdOf(source) !== schoolIdOf(student.profile) ||
    schoolIdOf(source) !== schoolIdOf(access)
  ) {
    throw new HttpsError('permission-denied', 'This homework belongs to another school.')
  }

  return access
}

async function getSource(collectionName, id) {
  const safeId = assertDocumentId(id)
  const snap = await db.doc(`${collectionName}/${safeId}`).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Homework was not found.')
  return { id: snap.id, ...snap.data() }
}

async function writeProjection(config, id, source) {
  const publicRef = db.doc(`${config.publicCollection}/${id}`)
  const projected = config.sanitizer({ id, ...source })
  delete projected.id
  await publicRef.set({
    ...projected,
    sourceId: id,
    projectionUpdatedAt: new Date().toISOString()
  })
}

async function mirrorWrite(event, config) {
  const after = event.data?.after
  const before = event.data?.before
  const id = event.params?.id
  if (!id) return

  const beforeSource = before?.exists ? (before.data() || {}) : null
  const afterSource = after?.exists ? (after.data() || {}) : null

  if (!after?.exists) {
    await Promise.all([
      db.doc(`${config.publicCollection}/${id}`).delete().catch(() => {}),
      syncStudentAccessChange({
        contentType: config.contentType,
        sourceCollection: config.sourceCollection,
        contentId: id,
        beforeSource,
        afterSource: null
      })
    ])
    return
  }

  await Promise.all([
    writeProjection(config, id, afterSource),
    syncStudentAccessChange({
      contentType: config.contentType,
      sourceCollection: config.sourceCollection,
      contentId: id,
      beforeSource,
      afterSource
    })
  ])
}

exports.mirrorReadingForStudents = onDocumentWritten('readings/{id}', event =>
  mirrorWrite(event, OBJECTIVE_CONFIG.reading)
)

exports.mirrorListeningForStudents = onDocumentWritten('listenings/{id}', event =>
  mirrorWrite(event, OBJECTIVE_CONFIG.listening)
)

exports.mirrorVocabularyForStudents = onDocumentWritten('vocabularyTests/{id}', event =>
  mirrorWrite(event, OBJECTIVE_CONFIG.vocabulary)
)

exports.syncWritingStudentAccess = onDocumentWritten('writingHomeworks/{id}', event =>
  syncStudentAccessWrite(event, 'writing', 'writingHomeworks')
)

exports.syncMockStudentAccess = onDocumentWritten('mockTests/{id}', event =>
  syncStudentAccessWrite(event, 'mock', 'mockTests')
)

// Stage 16G-B: canonical assignment writer. Existing Create/Teacher screens are
// migrated to this callable in later 16G steps; legacy source arrays remain
// temporarily as a compatibility bridge until every writer has cut over.
exports.setContentStudentAccess = onCall(async request => {
  const manager = await requireAssignmentManager(request)
  const data = request.data || {}
  const config = accessContentConfigFor(data.contentType)
  const contentId = assertDocumentId(data.contentId, 'Content ID')
  const studentIds = assertStudentUidList(data.studentIds)
  const source = await getSource(config.sourceCollection, contentId)

  if (!managerCanManageSource(manager, source)) {
    throw new HttpsError('permission-denied', 'You cannot manage assignments for this content.')
  }

  const sourceSchoolId = schoolIdOf(source)
  await loadAssignableStudents(studentIds, sourceSchoolId)

  const currentSnap = await db.collection('studentAccess')
    .where('contentId', '==', contentId)
    .get()

  const currentAssignments = new Map()
  for (const docSnap of currentSnap.docs) {
    const access = docSnap.data() || {}
    if (
      access.contentType === config.contentType &&
      access.sourceCollection === config.sourceCollection &&
      schoolIdOf(access) === sourceSchoolId &&
      access.accessType === 'assignment' &&
      typeof access.uid === 'string' &&
      access.uid
    ) {
      currentAssignments.set(access.uid, { ref: docSnap.ref, access })
    }
  }

  const targetSet = new Set(studentIds)
  const operations = []
  let created = 0
  let updated = 0
  let removed = 0
  let inactive = 0

  for (const uid of studentIds) {
    const existing = currentAssignments.get(uid)
    const ref = db.doc(`studentAccess/${studentAccessId(uid, config.contentType, contentId)}`)
    const payload = studentAccessPayload(
      config.contentType,
      config.sourceCollection,
      contentId,
      source,
      uid
    )

    if (!existing) {
      payload.assignedAt = FieldValue.serverTimestamp()
      created++
    } else {
      updated++
    }
    if (payload.status !== 'active') inactive++

    operations.push({ type: 'set', ref, data: payload })
  }

  for (const [uid, existing] of currentAssignments.entries()) {
    if (targetSet.has(uid)) continue
    operations.push({ type: 'delete', ref: existing.ref })
    removed++
  }

  await commitAccessOperations(operations)

  return {
    ok: true,
    contentType: config.contentType,
    contentId,
    assigned: studentIds.length,
    created,
    updated,
    removed,
    inactive
  }
})

function mockLinkedIds(mock, type) {
  if (type === 'reading') {
    return Array.isArray(mock?.readingIds)
      ? mock.readingIds.filter(Boolean)
      : mock?.readingId ? [mock.readingId] : []
  }

  if (type === 'listening') {
    return Array.isArray(mock?.listeningIds)
      ? mock.listeningIds.filter(Boolean)
      : mock?.listeningId ? [mock.listeningId] : []
  }

  return []
}

function assertMockResourceEnabled(mock, type, sourceId) {
  const enabled = getMockEnabledSections(mock)
  if (!enabled[type]) {
    throw new HttpsError('permission-denied', `The ${type} section is not enabled in this mock.`)
  }

  if (!mockLinkedIds(mock, type).includes(sourceId)) {
    throw new HttpsError('permission-denied', 'This resource is not linked to the assigned mock.')
  }
}

async function requireAssignedMock(mockTestId, student) {
  const mock = await getSource('mockTests', mockTestId)
  await requireAvailableStudentSource({
    source: mock,
    student,
    contentType: 'mock',
    contentId: mockTestId,
    sourceCollection: 'mockTests'
  })
  return mock
}

exports.ensureMockObjectiveResource = onCall(async request => {
  const student = await requireStudent(request)
  const data = request.data || {}
  const type = data.type

  if (!['reading', 'listening'].includes(type)) {
    throw new HttpsError('invalid-argument', 'Only Reading and Listening mock resources are supported.')
  }

  const config = OBJECTIVE_CONFIG[type]
  const mockTestId = assertDocumentId(data.mockTestId, 'Mock test ID')
  const sourceId = assertDocumentId(data.sourceId, 'Source ID')

  const mock = await requireAssignedMock(mockTestId, student)
  assertMockResourceEnabled(mock, type, sourceId)

  const source = await getSource(config.sourceCollection, sourceId)
  if (schoolIdOf(source) !== schoolIdOf(mock)) {
    throw new HttpsError('permission-denied', 'The linked resource belongs to another school.')
  }

  await writeProjection(config, sourceId, source)

  await db.doc(`mockResourceAccess/${student.uid}/${config.sourceCollection}/${sourceId}`).set({
    uid: student.uid,
    mockTestId,
    sourceCollection: config.sourceCollection,
    sourceId,
    schemaVersion: 2,
    updatedAt: FieldValue.serverTimestamp()
  })

  return { ok: true }
})

async function findExistingSubmission(config, student, assignmentId) {
  const deterministicId = `${student.uid}_${assignmentId}`
  const deterministic = await db.doc(`${config.submissionCollection}/${deterministicId}`).get()
  if (deterministic.exists) {
    return { id: deterministic.id, ...deterministic.data() }
  }

  const legacy = await db.collection(config.submissionCollection)
    .where('uid', '==', student.uid)
    .where(config.parentField, '==', assignmentId)
    .limit(1)
    .get()

  if (!legacy.empty) {
    const docSnap = legacy.docs[0]
    return { id: docSnap.id, ...docSnap.data() }
  }

  return null
}

async function createImmutableSubmission(config, student, assignmentId, data) {
  const ref = db.doc(`${config.submissionCollection}/${student.uid}_${assignmentId}`)

  await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref)
    if (snap.exists) {
      throw new HttpsError('already-exists', 'You already submitted this homework.')
    }
    transaction.create(ref, data)
  })

  return ref.id
}

function baseSubmission(source, student) {
  const teacherIds = teacherIdsOf(source)
  return {
    uid: student.uid,
    studentId: student.uid,
    studentEmail: student.email || '',
    studentName: student.profile.name || student.profile.fullName || student.email || '',
    schoolId: schoolIdOf(source),
    teacherId: teacherIds[0] || '',
    teacherIds,
    submittedAt: new Date().toISOString(),
    gradedByServer: true,
    gradingSchemaVersion: 1
  }
}

exports.submitReadingSecure = onCall(async request => {
  const student = await requireStudent(request)
  const data = request.data || {}
  const readingId = assertDocumentId(data.readingId, 'Reading ID')
  const { answers = {}, flaggedQuestions = [], studentNote = '', highlights = [], autoSubmitted = false, finishedLate = false } = data
  assertSmallPlainObject(answers, 'Answers')
  assertJsonSize({ answers, flaggedQuestions, studentNote, highlights }, 'Reading submission payload', 600000)

  const config = OBJECTIVE_CONFIG.reading
  const source = await getSource(config.sourceCollection, readingId)
  await requireAvailableStudentSource({
    source,
    student,
    contentType: config.contentType,
    contentId: readingId,
    sourceCollection: config.sourceCollection
  })

  const existing = await findExistingSubmission(config, student, readingId)
  if (existing) {
    return { alreadySubmitted: true, result: existing.result || null, reviewSource: toPlain(source) }
  }

  const result = gradeReading(source, answers)
  const submission = {
    ...baseSubmission(source, student),
    readingId,
    answers,
    flaggedQuestions: safeStringArray(flaggedQuestions),
    studentNote: safeString(studentNote, 5000),
    highlights: safeJsonArray(highlights, 'Highlights'),
    result,
    finishedLate: finishedLate === true,
    autoSubmitted: autoSubmitted === true,
    archived: false
  }

  try {
    await createImmutableSubmission(config, student, readingId, submission)
  } catch (error) {
    if (error instanceof HttpsError && error.code === 'already-exists') {
      const raced = await findExistingSubmission(config, student, readingId)
      return { alreadySubmitted: true, result: raced?.result || result, reviewSource: toPlain(source) }
    }
    throw error
  }

  return { alreadySubmitted: false, result, reviewSource: toPlain(source) }
})

exports.submitListeningSecure = onCall(async request => {
  const student = await requireStudent(request)
  const data = request.data || {}
  const listeningId = assertDocumentId(data.listeningId, 'Listening ID')
  const { answers = {}, flaggedQuestions = [], studentNote = '', autoSubmitted = false, finishedLate = false } = data
  assertSmallPlainObject(answers, 'Answers')
  assertJsonSize({ answers, flaggedQuestions, studentNote }, 'Listening submission payload', 550000)

  const config = OBJECTIVE_CONFIG.listening
  const source = await getSource(config.sourceCollection, listeningId)
  await requireAvailableStudentSource({
    source,
    student,
    contentType: config.contentType,
    contentId: listeningId,
    sourceCollection: config.sourceCollection
  })

  const existing = await findExistingSubmission(config, student, listeningId)
  if (existing) {
    return { alreadySubmitted: true, result: existing.result || null, reviewSource: toPlain(source) }
  }

  const result = gradeListening(source, answers)
  const submission = {
    ...baseSubmission(source, student),
    listeningId,
    answers,
    flaggedQuestions: safeStringArray(flaggedQuestions),
    studentNote: safeString(studentNote, 5000),
    result,
    finishedLate: finishedLate === true,
    autoSubmitted: autoSubmitted === true,
    archived: false
  }

  try {
    await createImmutableSubmission(config, student, listeningId, submission)
  } catch (error) {
    if (error instanceof HttpsError && error.code === 'already-exists') {
      const raced = await findExistingSubmission(config, student, listeningId)
      return { alreadySubmitted: true, result: raced?.result || result, reviewSource: toPlain(source) }
    }
    throw error
  }

  return { alreadySubmitted: false, result, reviewSource: toPlain(source) }
})

exports.submitVocabularySecure = onCall(async request => {
  const student = await requireStudent(request)
  const data = request.data || {}
  const vocabularyTestId = assertDocumentId(data.vocabularyTestId, 'Vocabulary test ID')
  const { answers = {}, autoSubmitted = false, finishedLate = false } = data
  assertSmallPlainObject(answers, 'Answers')
  assertJsonSize({ answers }, 'Vocabulary submission payload', 500000)

  const config = OBJECTIVE_CONFIG.vocabulary
  const source = await getSource(config.sourceCollection, vocabularyTestId)
  await requireAvailableStudentSource({
    source,
    student,
    contentType: config.contentType,
    contentId: vocabularyTestId,
    sourceCollection: config.sourceCollection
  })

  const existing = await findExistingSubmission(config, student, vocabularyTestId)
  if (existing) {
    return { alreadySubmitted: true, result: existing.result || null, reviewSource: toPlain(source) }
  }

  const result = gradeVocabulary(source, answers)
  const submission = {
    ...baseSubmission(source, student),
    vocabularyTestId,
    vocabularyId: vocabularyTestId,
    testId: vocabularyTestId,
    homeworkId: vocabularyTestId,
    vocabularyTitle: source.title || '',
    matchingViewVersion: 1,
    answers,
    result,
    archived: false,
    finishedLate: finishedLate === true,
    autoSubmitted: autoSubmitted === true
  }

  try {
    await createImmutableSubmission(config, student, vocabularyTestId, submission)
  } catch (error) {
    if (error instanceof HttpsError && error.code === 'already-exists') {
      const raced = await findExistingSubmission(config, student, vocabularyTestId)
      return { alreadySubmitted: true, result: raced?.result || result, reviewSource: toPlain(source) }
    }
    throw error
  }

  await db.doc(`vocabularyDrafts/${student.uid}_${vocabularyTestId}`).delete().catch(() => {})
  return { alreadySubmitted: false, result, reviewSource: toPlain(source) }
})

async function getMockSources(mock) {
  const enabled = getMockEnabledSections(mock)
  const listeningIds = enabled.listening ? mockLinkedIds(mock, 'listening') : []
  const readingIds = enabled.reading ? mockLinkedIds(mock, 'reading') : []

  const [listenings, readings, writing] = await Promise.all([
    Promise.all(listeningIds.map(id => getSource('listenings', id))),
    Promise.all(readingIds.map(id => getSource('readings', id))),
    enabled.writing && mock.writingId
      ? getSource('writingHomeworks', mock.writingId)
      : Promise.resolve(null)
  ])

  return { listenings, readings, writing }
}

async function findExistingMockSubmission(student, mockTestId) {
  const ref = db.doc(`mockSubmissions/${student.uid}_${mockTestId}`)
  const snap = await ref.get()
  if (snap.exists) return { id: snap.id, ...snap.data() }

  const legacy = await db.collection('mockSubmissions')
    .where('uid', '==', student.uid)
    .where('mockTestId', '==', mockTestId)
    .limit(1)
    .get()
  if (!legacy.empty) return { id: legacy.docs[0].id, ...legacy.docs[0].data() }
  return null
}

function mockReviewSources(sources) {
  return {
    listenings: sources.listenings.map(toPlain),
    readings: sources.readings.map(toPlain),
    writing: sources.writing ? toPlain(sources.writing) : null
  }
}

exports.submitMockSecure = onCall(async request => {
  const student = await requireStudent(request)
  const data = request.data || {}
  const mockTestId = assertDocumentId(data.mockTestId, 'Mock test ID')
  const { listeningAnswers = {}, readingAnswers = {}, writingAnswers = {}, autoSubmitted = false } = data
  assertSmallPlainObject(listeningAnswers, 'Listening answers', 250000)
  assertSmallPlainObject(readingAnswers, 'Reading answers', 250000)
  assertSmallPlainObject(writingAnswers, 'Writing answers', 200000)
  assertJsonSize({
    listeningAnswers,
    readingAnswers,
    writingAnswers,
    sectionTimeLimits: data.sectionTimeLimits || {},
    timing: data.timing || {}
  }, 'Mock submission payload', 650000)

  const mock = await requireAssignedMock(mockTestId, student)
  const existing = await findExistingMockSubmission(student, mockTestId)
  const sources = await getMockSources(mock)

  if (existing) {
    return {
      alreadySubmitted: true,
      result: existing.result || null,
      reviewSources: mockReviewSources(sources)
    }
  }

  const result = gradeMock(mock, sources.listenings, sources.readings, sources.writing, {
    listeningAnswers,
    readingAnswers,
    writingAnswers
  })

  const enabledSections = getMockEnabledSections(mock)
  const writingMode = getMockWritingMode(mock, sources.writing)
  const teacherIds = teacherIdsOf(mock)
  const submittedAt = new Date().toISOString()
  const listeningIds = mockLinkedIds(mock, 'listening')
  const readingIds = mockLinkedIds(mock, 'reading')

  const submissionData = {
    ...baseSubmission(mock, student),
    submittedAt,
    mockTestId,
    title: mock.title || 'Untitled Mock Test',
    mockType: mock.mockType || mock.contentType || 'full_mock',
    contentType: mock.mockType || mock.contentType || 'full_mock',
    enabledSections,
    writingMode,
    task1Enabled: enabledSections.writing && writingMode !== 'task2_only',
    task2Enabled: enabledSections.writing && writingMode !== 'task1_only',
    sectionTimeLimits: data.sectionTimeLimits === undefined || data.sectionTimeLimits === null
      ? mock.sectionTimeLimits || {}
      : safePlainObject(data.sectionTimeLimits, 'Section time limits', 25000),
    listeningId: listeningIds[0] || '',
    listeningIds,
    readingIds,
    writingId: mock.writingId || '',
    listeningAnswers,
    readingAnswers,
    writingAnswers: {
      task1: safeString(writingAnswers.task1, 50000),
      task2: safeString(writingAnswers.task2, 80000)
    },
    result,
    autoSubmitted: autoSubmitted === true,
    tabSwitchCount: Number.isFinite(Number(data.tabSwitchCount))
      ? Math.max(0, Math.min(10000, Number(data.tabSwitchCount))) : 0,
    timing: safePlainObject(data.timing, 'Timing', 50000),
    status: 'submitted'
  }

  const scoreData = {
    uid: student.uid,
    studentId: student.uid,
    studentEmail: student.email || '',
    schoolId: schoolIdOf(mock),
    teacherId: teacherIds[0] || '',
    teacherIds,
    date: submittedAt.slice(0, 10),
    source: 'mock_test',
    mockTestId,
    listening: enabledSections.listening ? result.listening?.band || '' : '',
    reading: enabledSections.reading ? result.reading?.band || '' : '',
    writing: '',
    speaking: '',
    overall: result.overallEstimate ?? '',
    createdAt: submittedAt,
    gradedByServer: true,
    gradingSchemaVersion: 1
  }

  const submissionRef = db.doc(`mockSubmissions/${student.uid}_${mockTestId}`)
  const scoreRef = db.doc(`scores/${student.uid}_${mockTestId}`)

  try {
    await db.runTransaction(async transaction => {
      const snap = await transaction.get(submissionRef)
      if (snap.exists) {
        throw new HttpsError('already-exists', 'You already submitted this mock test.')
      }
      transaction.create(submissionRef, submissionData)
      transaction.set(scoreRef, scoreData)
    })
  } catch (error) {
    if (error instanceof HttpsError && error.code === 'already-exists') {
      const raced = await findExistingMockSubmission(student, mockTestId)
      return {
        alreadySubmitted: true,
        result: raced?.result || result,
        reviewSources: mockReviewSources(sources)
      }
    }
    throw error
  }

  return {
    alreadySubmitted: false,
    result,
    reviewSources: mockReviewSources(sources)
  }
})

exports.getCompletedObjectiveReview = onCall(async request => {
  const student = await requireStudent(request)
  const data = request.data || {}
  const type = data.type
  const config = objectiveConfigFor(type)
  const assignmentId = assertDocumentId(data.assignmentId, 'Assignment ID')

  const existing = await findExistingSubmission(config, student, assignmentId)
  if (!existing) throw new HttpsError('permission-denied', 'Submit this homework before opening the answer review.')

  const source = await getSource(config.sourceCollection, assignmentId)
  return { source: toPlain(source), result: existing.result || null }
})

exports.getCompletedMockReview = onCall(async request => {
  const student = await requireStudent(request)
  const data = request.data || {}
  const mockTestId = assertDocumentId(data.mockTestId, 'Mock test ID')
  const existing = await findExistingMockSubmission(student, mockTestId)
  if (!existing) throw new HttpsError('permission-denied', 'Submit this mock before opening the answer review.')

  const mock = await getSource('mockTests', mockTestId)
  const sources = await getMockSources(mock)
  return {
    result: existing.result || null,
    reviewSources: mockReviewSources(sources)
  }
})
