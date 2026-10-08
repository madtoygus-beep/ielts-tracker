'use strict'

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { createHash } = require('crypto')
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

// Stage 16L-1: submission-attempt foundation. Existing submission collections
// remain the current/latest head documents; immutable prior attempts live in
// submissionAttemptHistory and reopen permissions live in submissionAttemptControls.
const SUBMISSION_CONTENT_CONFIG = {
  reading: {
    contentType: 'reading',
    sourceCollection: 'readings',
    submissionCollection: 'readingSubmissions',
    parentFields: ['readingId']
  },
  listening: {
    contentType: 'listening',
    sourceCollection: 'listenings',
    submissionCollection: 'listeningSubmissions',
    parentFields: ['listeningId']
  },
  vocabulary: {
    contentType: 'vocabulary',
    sourceCollection: 'vocabularyTests',
    submissionCollection: 'vocabularySubmissions',
    parentFields: ['vocabularyTestId', 'vocabularyId', 'testId', 'homeworkId']
  },
  writing: {
    contentType: 'writing',
    sourceCollection: 'writingHomeworks',
    submissionCollection: 'writingSubmissions',
    parentFields: ['writingId']
  },
  mock: {
    contentType: 'mock',
    sourceCollection: 'mockTests',
    submissionCollection: 'mockSubmissions',
    parentFields: ['mockTestId']
  }
}

const ATTEMPT_SCHEMA_VERSION = 1
const ATTEMPT_CONTROL_COLLECTION = 'submissionAttemptControls'
const ATTEMPT_HISTORY_COLLECTION = 'submissionAttemptHistory'
const ATTEMPT_MODES = new Set(['reopen_answers', 'start_fresh'])

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

const STUDENT_ACCESS_SCHEMA_VERSION = 1
const REVIEW_POLICIES = new Set(['immediate', 'teacher_release', 'scheduled', 'never'])

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

  return {
    uid,
    schoolId: schoolIdOf(source),
    contentType,
    contentId,
    sourceCollection,
    accessType: 'assignment',
    status: source?.archived === true ? 'inactive' : 'active',
    assignedBy: teacherIds[0] || '',
    reviewPolicy: reviewPolicyOf(source),
    reviewReleaseAt: source?.reviewReleaseAt ?? null,
    dueAt: source?.dueAt ?? source?.dueDate ?? null,
    schemaVersion: STUDENT_ACCESS_SCHEMA_VERSION,
    updatedAt: FieldValue.serverTimestamp()
  }
}

async function cleanupStudentAccessForDeletedContent({
  contentType,
  sourceCollection,
  contentId
}) {
  if (!contentId) return 0

  const snap = await db.collection('studentAccess')
    .where('contentId', '==', contentId)
    .get()

  const operations = snap.docs
    .map(docSnap => ({ docSnap, access: docSnap.data() || {} }))
    .filter(({ access }) =>
      access.accessType === 'assignment' &&
      access.contentType === contentType &&
      access.sourceCollection === sourceCollection
    )
    .map(({ docSnap }) => ({ type: 'delete', ref: docSnap.ref }))

  await commitAccessOperations(operations)
  return operations.length
}

async function cleanupStudentAccessOnSourceDelete(event, contentType, sourceCollection) {
  const id = event.params?.id
  const after = event.data?.after

  if (!id || after?.exists) return

  await cleanupStudentAccessForDeletedContent({
    contentType,
    sourceCollection,
    contentId: id
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

function submissionContentConfigFor(type) {
  const key = typeof type === 'string' ? type.trim() : ''
  const config = SUBMISSION_CONTENT_CONFIG[key]
  if (!config) {
    throw new HttpsError('invalid-argument', 'Unsupported submission content type.')
  }
  return config
}

function assertAttemptMode(value) {
  const mode = typeof value === 'string' ? value.trim() : ''
  if (!ATTEMPT_MODES.has(mode)) {
    throw new HttpsError('invalid-argument', 'Attempt mode must be reopen_answers or start_fresh.')
  }
  return mode
}

function attemptNumberOf(data) {
  const value = Number(data?.attemptNumber)
  return Number.isInteger(value) && value >= 1 ? value : 1
}

function attemptControlId(uid, contentType, contentId) {
  return createHash('sha256')
    .update(`${uid}\u001f${contentType}\u001f${contentId}`, 'utf8')
    .digest('hex')
}

function attemptHistoryId(controlId, attemptNumber) {
  return `${controlId}_attempt_${attemptNumber}`
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

async function requireAdmin(request) {
  const manager = await requireAssignmentManager(request)
  if (manager.profile.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access is required for this action.')
  }
  return manager
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

function normalizeManagedAssignmentSnapshotItems(value) {
  if (!Array.isArray(value)) {
    throw new HttpsError('invalid-argument', 'Content items must be an array.')
  }
  if (value.length > 400) {
    throw new HttpsError('invalid-argument', 'Too many content items were requested at once.')
  }

  const items = []
  const seen = new Set()

  for (const rawItem of value) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new HttpsError('invalid-argument', 'Each content item must be an object.')
    }

    const config = accessContentConfigFor(rawItem.contentType)
    const contentId = assertDocumentId(rawItem.contentId, 'Content ID')
    const key = `${config.contentType}:${contentId}`

    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      key,
      contentType: config.contentType,
      sourceCollection: config.sourceCollection,
      contentId
    })
  }

  return items
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
  const id = event.params?.id
  if (!id) return

  if (!after?.exists) {
    await Promise.all([
      db.doc(`${config.publicCollection}/${id}`).delete().catch(() => {}),
      cleanupStudentAccessForDeletedContent({
        contentType: config.contentType,
        sourceCollection: config.sourceCollection,
        contentId: id
      })
    ])
    return
  }

  await writeProjection(config, id, after.data() || {})
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

// Stage 16G-I3: keep these deployed trigger names during the transition, but
// retire legacy assignment-array syncing. They now clean canonical access only
// when the source content is physically deleted.
exports.syncWritingStudentAccess = onDocumentWritten('writingHomeworks/{id}', event =>
  cleanupStudentAccessOnSourceDelete(event, 'writing', 'writingHomeworks')
)

exports.syncMockStudentAccess = onDocumentWritten('mockTests/{id}', event =>
  cleanupStudentAccessOnSourceDelete(event, 'mock', 'mockTests')
)

// Stage 16G-B2: canonical assignment reader for staff edit screens. This keeps
// assignment UI state sourced from studentAccess instead of stale legacy arrays.
exports.getContentStudentAccess = onCall(async request => {
  const manager = await requireAssignmentManager(request)
  const data = request.data || {}
  const config = accessContentConfigFor(data.contentType)
  const contentId = assertDocumentId(data.contentId, 'Content ID')
  const source = await getSource(config.sourceCollection, contentId)

  if (!managerCanManageSource(manager, source)) {
    throw new HttpsError('permission-denied', 'You cannot view assignments for this content.')
  }

  const sourceSchoolId = schoolIdOf(source)
  const currentSnap = await db.collection('studentAccess')
    .where('contentId', '==', contentId)
    .get()

  const studentIds = []
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
      studentIds.push(access.uid)
    }
  }

  return {
    ok: true,
    contentType: config.contentType,
    contentId,
    studentIds: uniqueStrings(studentIds)
  }
})

// Stage 16G-I4A: one server-authorized canonical assignment snapshot for the
// TeacherDashboard. Teachers only receive assignment membership for source
// content they are allowed to manage; admins receive the requested content
// they can manage. Inactive/admin-hidden membership is intentionally included
// because this snapshot represents assignment membership, not student access.
exports.getManagedContentStudentAccessSnapshot = onCall(async request => {
  const manager = await requireAssignmentManager(request)
  const data = request.data || {}
  const items = normalizeManagedAssignmentSnapshotItems(data.items)

  if (items.length === 0) {
    return { ok: true, assignments: [] }
  }

  const sourceRefs = items.map(item =>
    db.doc(`${item.sourceCollection}/${item.contentId}`)
  )
  const sourceSnaps = await db.getAll(...sourceRefs)
  const allowedByKey = new Map()

  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const sourceSnap = sourceSnaps[index]
    if (!sourceSnap?.exists) continue

    const source = sourceSnap.data() || {}
    if (!managerCanManageSource(manager, source)) continue

    allowedByKey.set(item.key, {
      contentType: item.contentType,
      contentId: item.contentId,
      sourceCollection: item.sourceCollection,
      schoolId: schoolIdOf(source),
      studentIds: []
    })
  }

  if (allowedByKey.size > 0) {
    const contentIds = uniqueStrings(
      Array.from(allowedByKey.values()).map(item => item.contentId)
    )
    const queryChunkSize = 10

    for (let start = 0; start < contentIds.length; start += queryChunkSize) {
      const contentIdChunk = contentIds.slice(start, start + queryChunkSize)
      const accessSnap = await db.collection('studentAccess')
        .where('contentId', 'in', contentIdChunk)
        .get()

      for (const docSnap of accessSnap.docs) {
        const access = docSnap.data() || {}
        if (
          access.accessType !== 'assignment' ||
          typeof access.contentType !== 'string' ||
          typeof access.contentId !== 'string' ||
          typeof access.uid !== 'string' ||
          !access.uid
        ) {
          continue
        }

        const key = `${access.contentType}:${access.contentId}`
        const target = allowedByKey.get(key)
        if (!target) continue

        if (
          access.sourceCollection !== target.sourceCollection ||
          schoolIdOf(access) !== target.schoolId
        ) {
          continue
        }

        target.studentIds.push(access.uid)
      }
    }
  }

  return {
    ok: true,
    assignments: Array.from(allowedByKey.values()).map(item => ({
      contentType: item.contentType,
      contentId: item.contentId,
      studentIds: uniqueStrings(item.studentIds)
    }))
  }
})

// Stage 16G-I4C: canonical assignment writer. studentAccess is authoritative;
// legacy source assignment arrays are no longer read or written here.
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
    const adminHidden = existing?.access?.adminHidden === true
    const ref = db.doc(`studentAccess/${studentAccessId(uid, config.contentType, contentId)}`)
    const payload = studentAccessPayload(
      config.contentType,
      config.sourceCollection,
      contentId,
      source,
      uid
    )

    if (adminHidden) {
      payload.status = 'inactive'
      payload.adminHidden = true
    }

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
    inactive,
    legacyBridgeUpdated: false
  }
})

// Stage 16G-I4C: canonical archive/restore writer. Archive state remains source
// metadata, while assignment availability is updated directly in studentAccess.
exports.setContentArchivedState = onCall(async request => {
  const manager = await requireAssignmentManager(request)
  const data = request.data || {}
  const config = accessContentConfigFor(data.contentType)
  const contentId = assertDocumentId(data.contentId, 'Content ID')

  if (typeof data.archived !== 'boolean') {
    throw new HttpsError('invalid-argument', 'Archived state must be true or false.')
  }

  const archived = data.archived
  const source = await getSource(config.sourceCollection, contentId)

  if (!managerCanManageSource(manager, source)) {
    throw new HttpsError('permission-denied', 'You cannot archive or restore this content.')
  }

  const sourceSchoolId = schoolIdOf(source)
  const currentSnap = await db.collection('studentAccess')
    .where('contentId', '==', contentId)
    .get()

  const operations = []

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
      const shouldStayInactive = archived || access.adminHidden === true

      operations.push({
        type: 'set',
        ref: docSnap.ref,
        data: {
          status: shouldStayInactive ? 'inactive' : 'active',
          updatedAt: FieldValue.serverTimestamp()
        }
      })
    }
  }

  const sourceRef = db.doc(`${config.sourceCollection}/${contentId}`)
  const sourceUpdate = {
    archived,
    updatedBy: manager.uid,
    updatedAt: FieldValue.serverTimestamp()
  }

  // Safe ordering: archive access first, then the source. Restore the source
  // first, then access. This avoids a window where students gain availability
  // before the source itself is restored.
  if (archived) {
    await commitAccessOperations(operations)
    await sourceRef.set(sourceUpdate, { merge: true })
  } else {
    await sourceRef.set(sourceUpdate, { merge: true })
    await commitAccessOperations(operations)
  }

  return {
    ok: true,
    contentType: config.contentType,
    contentId,
    archived,
    affectedAssignments: operations.length
  }
})

// Stage 16G-I4C: admin-only canonical assignment visibility. Submission/result
// archiving remains in AdminDashboard for now; this callable controls only
// studentAccess availability and no longer writes legacy source markers.
exports.setStudentAssignmentVisibility = onCall(async request => {
  const admin = await requireAdmin(request)
  const data = request.data || {}
  const studentId = assertDocumentId(data.studentId, 'Student ID')
  const scope = typeof data.scope === 'string' ? data.scope.trim() : ''

  if (scope !== 'homework' && scope !== 'mock') {
    throw new HttpsError('invalid-argument', 'Visibility scope must be homework or mock.')
  }
  if (typeof data.hidden !== 'boolean') {
    throw new HttpsError('invalid-argument', 'Hidden state must be true or false.')
  }

  const hidden = data.hidden
  const studentSnap = await db.doc(`users/${studentId}`).get()
  if (!studentSnap.exists) {
    throw new HttpsError('not-found', 'Student profile was not found.')
  }

  const studentProfile = studentSnap.data() || {}
  if (studentProfile.role !== 'student') {
    throw new HttpsError('failed-precondition', 'The selected profile is not a student.')
  }

  const studentSchoolId = schoolIdOf(studentProfile)
  const allowedTypes = scope === 'mock'
    ? new Set(['mock'])
    : new Set(['reading', 'listening', 'writing', 'vocabulary'])

  const accessSnap = await db.collection('studentAccess')
    .where('uid', '==', studentId)
    .get()

  const candidates = accessSnap.docs
    .map(docSnap => ({ docSnap, access: docSnap.data() || {} }))
    .filter(({ access }) =>
      access.accessType === 'assignment' &&
      allowedTypes.has(access.contentType) &&
      schoolIdOf(access) === studentSchoolId &&
      typeof access.contentId === 'string' &&
      access.contentId &&
      typeof access.sourceCollection === 'string' &&
      access.sourceCollection
    )

  const sourceRefs = candidates.map(({ access }) =>
    db.doc(`${access.sourceCollection}/${access.contentId}`)
  )
  const sourceSnaps = sourceRefs.length > 0
    ? await db.getAll(...sourceRefs)
    : []

  const studentIsActive =
    studentProfile.status === 'approved' && studentProfile.deleted !== true
  const now = FieldValue.serverTimestamp()
  const accessOperations = []

  for (let index = 0; index < candidates.length; index++) {
    const { docSnap, access } = candidates[index]
    const sourceSnap = sourceSnaps[index]
    const sourceExists = Boolean(sourceSnap?.exists)
    const source = sourceExists ? (sourceSnap.data() || {}) : {}
    const sourceArchived = !sourceExists || source.archived === true
    const status = hidden || !studentIsActive || sourceArchived
      ? 'inactive'
      : 'active'

    accessOperations.push({
      type: 'set',
      ref: docSnap.ref,
      data: {
        status,
        adminHidden: hidden,
        visibilityUpdatedAt: now,
        visibilityUpdatedBy: admin.uid,
        ...(hidden
          ? { adminHiddenAt: now, adminHiddenBy: admin.uid }
          : { adminRestoredAt: now, adminRestoredBy: admin.uid }),
        updatedAt: now
      }
    })
  }

  await commitAccessOperations(accessOperations)

  return {
    ok: true,
    studentId,
    scope,
    hidden,
    affectedAssignments: accessOperations.length,
    legacyBridgeUpdated: 0
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

function submittedAtMillis(data) {
  const value = data?.submittedAt
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  if (value instanceof Date) return value.getTime()
  if (typeof value?.toMillis === 'function') return value.toMillis()
  if (typeof value?.toDate === 'function') return value.toDate().getTime()
  return 0
}

function hasMeaningfulValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.some(hasMeaningfulValue)
  if (typeof value === 'object') return Object.values(value).some(hasMeaningfulValue)
  return false
}

function submissionHasMeaningfulAnswers(config, data) {
  if (config.contentType === 'reading' || config.contentType === 'listening' || config.contentType === 'vocabulary') {
    return hasMeaningfulValue(data?.answers)
  }
  if (config.contentType === 'writing') {
    return hasMeaningfulValue(data?.task1Answer) || hasMeaningfulValue(data?.task2Answer)
  }
  if (config.contentType === 'mock') {
    return hasMeaningfulValue(data?.listeningAnswers) ||
      hasMeaningfulValue(data?.readingAnswers) ||
      hasMeaningfulValue(data?.writingAnswers)
  }
  return false
}

function submissionMatchesContent(config, data, contentId) {
  return config.parentFields.some(field => data?.[field] === contentId)
}

function recordFromSubmissionSnap(config, snap, deterministic = false) {
  const data = snap.data() || {}
  return {
    id: snap.id,
    ref: snap.ref,
    data,
    deterministic,
    meaningful: submissionHasMeaningfulAnswers(config, data),
    submittedAtMillis: submittedAtMillis(data),
    updateTime: snap.updateTime || null,
    ...data
  }
}

function chooseLegacyCurrentSubmission(records) {
  if (records.length === 0) return null

  return [...records].sort((a, b) => {
    if (a.meaningful !== b.meaningful) return a.meaningful ? -1 : 1
    if (a.submittedAtMillis !== b.submittedAtMillis) {
      return b.submittedAtMillis - a.submittedAtMillis
    }
    if ((a.data?.autoSubmitted === true) !== (b.data?.autoSubmitted === true)) {
      return a.data?.autoSubmitted === true ? 1 : -1
    }
    return a.id.localeCompare(b.id)
  })[0]
}

async function findCurrentSubmissionRecord(config, uid, contentId) {
  const deterministicId = `${uid}_${contentId}`
  const deterministic = await db.doc(`${config.submissionCollection}/${deterministicId}`).get()
  if (deterministic.exists) {
    return recordFromSubmissionSnap(config, deterministic, true)
  }

  const [uidSnap, studentIdSnap] = await Promise.all([
    db.collection(config.submissionCollection).where('uid', '==', uid).get(),
    db.collection(config.submissionCollection).where('studentId', '==', uid).get()
  ])

  const byId = new Map()
  for (const docSnap of [...uidSnap.docs, ...studentIdSnap.docs]) {
    if (byId.has(docSnap.id)) continue
    const data = docSnap.data() || {}
    if (!submissionMatchesContent(config, data, contentId)) continue
    byId.set(docSnap.id, recordFromSubmissionSnap(config, docSnap, false))
  }

  return chooseLegacyCurrentSubmission(Array.from(byId.values()))
}

async function findExistingSubmission(config, student, assignmentId) {
  const submissionConfig = submissionContentConfigFor(config.contentType)
  return findCurrentSubmissionRecord(submissionConfig, student.uid, assignmentId)
}

async function findCurrentMockScoreRecord(uid, mockTestId) {
  const deterministic = await db.doc(`scores/${uid}_${mockTestId}`).get()
  if (deterministic.exists) {
    return {
      id: deterministic.id,
      ref: deterministic.ref,
      data: deterministic.data() || {},
      updateTime: deterministic.updateTime || null
    }
  }

  const [uidSnap, studentIdSnap] = await Promise.all([
    db.collection('scores').where('uid', '==', uid).get(),
    db.collection('scores').where('studentId', '==', uid).get()
  ])

  const records = new Map()
  for (const docSnap of [...uidSnap.docs, ...studentIdSnap.docs]) {
    if (records.has(docSnap.id)) continue
    const data = docSnap.data() || {}
    if (data.mockTestId !== mockTestId && data.mockId !== mockTestId) continue
    records.set(docSnap.id, {
      id: docSnap.id,
      ref: docSnap.ref,
      data,
      submittedAtMillis: submittedAtMillis({ submittedAt: data.createdAt || data.date }),
      updateTime: docSnap.updateTime || null
    })
  }

  return Array.from(records.values()).sort((a, b) => {
    if (a.submittedAtMillis !== b.submittedAtMillis) {
      return b.submittedAtMillis - a.submittedAtMillis
    }
    return a.id.localeCompare(b.id)
  })[0] || null
}

function attemptResumePayload(config, submission) {
  const data = submission?.data || submission || {}

  if (config.contentType === 'reading') {
    return {
      answers: data.answers || {},
      flaggedQuestions: Array.isArray(data.flaggedQuestions) ? data.flaggedQuestions : [],
      studentNote: typeof data.studentNote === 'string' ? data.studentNote : '',
      highlights: Array.isArray(data.highlights) ? data.highlights : []
    }
  }

  if (config.contentType === 'listening') {
    return {
      answers: data.answers || {},
      flaggedQuestions: Array.isArray(data.flaggedQuestions) ? data.flaggedQuestions : [],
      studentNote: typeof data.studentNote === 'string' ? data.studentNote : ''
    }
  }

  if (config.contentType === 'vocabulary') {
    return {
      answers: data.answers || {},
      matchingViewVersion: data.matchingViewVersion === 1 ? 1 : 0
    }
  }

  if (config.contentType === 'writing') {
    return {
      task1Answer: typeof data.task1Answer === 'string' ? data.task1Answer : '',
      task2Answer: typeof data.task2Answer === 'string' ? data.task2Answer : ''
    }
  }

  if (config.contentType === 'mock') {
    return {
      listeningAnswers: data.listeningAnswers || {},
      readingAnswers: data.readingAnswers || {},
      writingAnswers: data.writingAnswers || { task1: '', task2: '' },
      timing: data.timing || {},
      sectionTimeLimits: data.sectionTimeLimits || {},
      tabSwitchCount: Number.isFinite(Number(data.tabSwitchCount)) ? Number(data.tabSwitchCount) : 0
    }
  }

  return {}
}

async function requireManagedStudentAssignment(manager, config, source, studentId, contentId) {
  const sourceSchoolId = schoolIdOf(source)
  const [student] = await loadAssignableStudents([studentId], sourceSchoolId)
  const accessRef = db.doc(`studentAccess/${studentAccessId(studentId, config.contentType, contentId)}`)
  const accessSnap = await accessRef.get()

  if (!accessSnap.exists) {
    throw new HttpsError('failed-precondition', 'This homework is not currently assigned to the selected student.')
  }

  const access = accessSnap.data() || {}
  if (
    access.accessType !== 'assignment' ||
    access.uid !== studentId ||
    access.contentType !== config.contentType ||
    access.contentId !== contentId ||
    access.sourceCollection !== config.sourceCollection ||
    access.status !== 'active' ||
    schoolIdOf(access) !== sourceSchoolId ||
    access.adminHidden === true
  ) {
    throw new HttpsError('failed-precondition', 'Restore or reassign this homework before reopening an attempt.')
  }

  return { uid: studentId, profile: student.profile, accessRef, access }
}

function attemptControlClientState(control, current) {
  if (!control || control.status !== 'open') {
    return {
      open: false,
      currentAttemptNumber: current ? attemptNumberOf(current.data) : 0
    }
  }

  return {
    open: true,
    mode: control.mode,
    baseAttemptNumber: Number(control.baseAttemptNumber) || 1,
    nextAttemptNumber: Number(control.nextAttemptNumber) || 2,
    baseSubmissionId: control.baseSubmissionId || '',
    baseSubmittedAt: control.baseSubmittedAt || '',
    currentAttemptNumber: current ? attemptNumberOf(current.data) : Number(control.baseAttemptNumber) || 1
  }
}

exports.getManagedSubmissionAttemptState = onCall(async request => {
  const manager = await requireAssignmentManager(request)
  const data = request.data || {}
  const config = submissionContentConfigFor(data.contentType)
  const contentId = assertDocumentId(data.contentId, 'Content ID')
  const studentId = assertDocumentId(data.studentId, 'Student ID')
  const source = await getSource(config.sourceCollection, contentId)

  if (!managerCanManageSource(manager, source)) {
    throw new HttpsError('permission-denied', 'You cannot manage attempts for this content.')
  }

  const studentSnap = await db.doc(`users/${studentId}`).get()
  if (!studentSnap.exists || schoolIdOf(studentSnap.data() || {}) !== schoolIdOf(source)) {
    throw new HttpsError('not-found', 'The selected student was not found in this school.')
  }

  const [current, controlSnap] = await Promise.all([
    findCurrentSubmissionRecord(config, studentId, contentId),
    db.doc(`${ATTEMPT_CONTROL_COLLECTION}/${attemptControlId(studentId, config.contentType, contentId)}`).get()
  ])

  return {
    ok: true,
    contentType: config.contentType,
    contentId,
    studentId,
    hasSubmission: Boolean(current),
    currentSubmissionId: current?.id || '',
    ...attemptControlClientState(controlSnap.exists ? (controlSnap.data() || {}) : null, current)
  }
})

exports.setSubmissionAttemptControl = onCall(async request => {
  const manager = await requireAssignmentManager(request)
  const data = request.data || {}
  const config = submissionContentConfigFor(data.contentType)
  const contentId = assertDocumentId(data.contentId, 'Content ID')
  const studentId = assertDocumentId(data.studentId, 'Student ID')
  const mode = assertAttemptMode(data.mode)
  const source = await getSource(config.sourceCollection, contentId)

  if (!managerCanManageSource(manager, source)) {
    throw new HttpsError('permission-denied', 'You cannot reopen attempts for this content.')
  }
  if (source.archived === true) {
    throw new HttpsError('failed-precondition', 'Restore this content before reopening an attempt.')
  }

  await requireManagedStudentAssignment(manager, config, source, studentId, contentId)

  const current = await findCurrentSubmissionRecord(config, studentId, contentId)
  if (!current) {
    throw new HttpsError('failed-precondition', 'This student has no submitted attempt to reopen.')
  }

  const controlId = attemptControlId(studentId, config.contentType, contentId)
  const controlRef = db.doc(`${ATTEMPT_CONTROL_COLLECTION}/${controlId}`)
  const mockScore = config.contentType === 'mock'
    ? await findCurrentMockScoreRecord(studentId, contentId)
    : null

  const expectedUpdateMillis = typeof current.updateTime?.toMillis === 'function'
    ? current.updateTime.toMillis()
    : null

  const result = await db.runTransaction(async transaction => {
    const freshSnap = await transaction.get(current.ref)
    if (!freshSnap.exists) {
      throw new HttpsError('aborted', 'The current submission changed. Refresh and try again.')
    }

    if (
      expectedUpdateMillis !== null &&
      typeof freshSnap.updateTime?.toMillis === 'function' &&
      freshSnap.updateTime.toMillis() !== expectedUpdateMillis
    ) {
      throw new HttpsError('aborted', 'The current submission changed. Refresh and try again.')
    }

    const freshData = freshSnap.data() || {}
    if (
      (freshData.uid || freshData.studentId) !== studentId ||
      !submissionMatchesContent(config, freshData, contentId)
    ) {
      throw new HttpsError('failed-precondition', 'The selected submission no longer matches this student and content.')
    }

    const baseAttemptNumber = attemptNumberOf(freshData)
    const nextAttemptNumber = baseAttemptNumber + 1
    const historyRef = db.doc(`${ATTEMPT_HISTORY_COLLECTION}/${attemptHistoryId(controlId, baseAttemptNumber)}`)

    const [controlSnap, historySnap, scoreSnap] = await Promise.all([
      transaction.get(controlRef),
      transaction.get(historyRef),
      mockScore?.ref ? transaction.get(mockScore.ref) : Promise.resolve(null)
    ])

    if (controlSnap.exists) {
      const existingControl = controlSnap.data() || {}
      if (
        existingControl.status === 'open' &&
        existingControl.baseSubmissionId === freshSnap.id &&
        Number(existingControl.baseAttemptNumber) === baseAttemptNumber
      ) {
        transaction.set(controlRef, {
          mode,
          updatedBy: manager.uid,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true })

        return {
          ok: true,
          alreadyOpen: true,
          mode,
          baseAttemptNumber,
          nextAttemptNumber,
          currentSubmissionId: freshSnap.id
        }
      }

      if (existingControl.status === 'open') {
        throw new HttpsError('failed-precondition', 'A different reopen request is already active for this student and content.')
      }
    }

    if (!historySnap.exists) {
      const historyData = {
        schemaVersion: ATTEMPT_SCHEMA_VERSION,
        uid: studentId,
        studentId,
        schoolId: schoolIdOf(source),
        contentType: config.contentType,
        contentId,
        sourceCollection: config.sourceCollection,
        submissionCollection: config.submissionCollection,
        attemptNumber: baseAttemptNumber,
        sourceSubmissionId: freshSnap.id,
        submittedAt: freshData.submittedAt || '',
        archivedReason: 'reopened_for_new_attempt',
        archivedBy: manager.uid,
        archivedByRole: manager.profile.role,
        archivedAt: FieldValue.serverTimestamp(),
        submissionSnapshot: toPlain(freshData)
      }

      if (scoreSnap?.exists) {
        historyData.sourceScoreId = scoreSnap.id
        historyData.scoreSnapshot = toPlain(scoreSnap.data() || {})
      }

      transaction.create(historyRef, historyData)
    }

    transaction.set(controlRef, {
      schemaVersion: ATTEMPT_SCHEMA_VERSION,
      uid: studentId,
      studentId,
      schoolId: schoolIdOf(source),
      contentType: config.contentType,
      contentId,
      sourceCollection: config.sourceCollection,
      submissionCollection: config.submissionCollection,
      status: 'open',
      mode,
      baseAttemptNumber,
      nextAttemptNumber,
      baseSubmissionId: freshSnap.id,
      baseSubmittedAt: freshData.submittedAt || '',
      baseSubmissionUpdateTime: toPlain(freshSnap.updateTime),
      openedBy: manager.uid,
      openedByRole: manager.profile.role,
      openedAt: FieldValue.serverTimestamp(),
      updatedBy: manager.uid,
      updatedAt: FieldValue.serverTimestamp()
    })

    return {
      ok: true,
      alreadyOpen: false,
      mode,
      baseAttemptNumber,
      nextAttemptNumber,
      currentSubmissionId: freshSnap.id
    }
  })

  return result
})

exports.getStudentSubmissionAttemptState = onCall(async request => {
  const student = await requireStudent(request)
  const data = request.data || {}
  const config = submissionContentConfigFor(data.contentType)
  const contentId = assertDocumentId(data.contentId, 'Content ID')
  const source = await getSource(config.sourceCollection, contentId)

  await requireAvailableStudentSource({
    source,
    student,
    contentType: config.contentType,
    contentId,
    sourceCollection: config.sourceCollection
  })

  const controlRef = db.doc(`${ATTEMPT_CONTROL_COLLECTION}/${attemptControlId(student.uid, config.contentType, contentId)}`)
  const [controlSnap, current] = await Promise.all([
    controlRef.get(),
    findCurrentSubmissionRecord(config, student.uid, contentId)
  ])

  const control = controlSnap.exists ? (controlSnap.data() || {}) : null
  const state = attemptControlClientState(control, current)

  if (!state.open) {
    return {
      ok: true,
      contentType: config.contentType,
      contentId,
      ...state,
      resume: {}
    }
  }

  if (
    control.uid !== student.uid ||
    control.contentType !== config.contentType ||
    control.contentId !== contentId ||
    schoolIdOf(control) !== schoolIdOf(source)
  ) {
    throw new HttpsError('permission-denied', 'This reopen request is not valid for your account.')
  }

  if (!current || current.id !== control.baseSubmissionId) {
    throw new HttpsError('failed-precondition', 'Your reopen request is out of date. Ask your teacher to reopen the attempt again.')
  }

  return {
    ok: true,
    contentType: config.contentType,
    contentId,
    ...state,
    resume: control.mode === 'reopen_answers'
      ? attemptResumePayload(config, current)
      : {}
  }
})

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
    attemptNumber: 1,
    attemptSchemaVersion: ATTEMPT_SCHEMA_VERSION,
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
  return findCurrentSubmissionRecord(
    submissionContentConfigFor('mock'),
    student.uid,
    mockTestId
  )
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
