'use strict'

// P5B-3A: Institution-sponsored, teacher-selected automatic AI Writing policy.
// This stage ONLY stores assignment selection. There is no submission trigger,
// model request, student credit change, or paid evaluation here.
// P5B-3C must additionally verify the current policy, student assignment and
// school-funded budget BEFORE any provider request is started.

const { teacherClassQuery, currentTeacherStudents, teacherOwnsSource } = require('./aiWritingTeacherRelationship')

const PILOT_SCHOOL_ID = 'maxima'
const MAX_STUDENTS_PER_POLICY = 60
const SCHEMA_VERSION = 1
const VALID_ID = /^[A-Za-z0-9_-]{1,150}$/
const VALID_STUDENT_ID = /^[A-Za-z0-9_-]{6,128}$/
const VALID_CONTENT_TYPES = Object.freeze({
  writing: Object.freeze({ collection: 'writingHomeworks', context: 'homework' }),
  mock: Object.freeze({ collection: 'mockTests', context: 'mock' })
})

function createAiWritingSponsoredPolicyService({
  db, FieldValue, HttpsError, requireAssignmentManager,
  managerCanManageSource, schoolIdOf, accountTypeOf, teacherIdsOf,
  getMockEnabledSections
}) {
  const dependencies = [db, FieldValue, HttpsError, requireAssignmentManager,
    managerCanManageSource, schoolIdOf, accountTypeOf, teacherIdsOf, getMockEnabledSections]
  if (dependencies.some(value => !value)) throw new Error('Sponsored AI policy dependencies are missing.')

  const fail = (code, message) => { throw new HttpsError(code, message) }
  const dataOf = snap => snap?.exists ? (snap.data() || {}) : null
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

  function parseInput(request, isWrite) {
    const input = request?.data
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('invalid-argument', 'A valid policy request is required.')
    }
    const allowedKeys = isWrite
      ? ['contentType', 'contentId', 'enabled', 'studentIds']
      : ['contentType', 'contentId']
    if (Object.keys(input).some(key => !allowedKeys.includes(key))) {
      fail('invalid-argument', 'Unexpected AI policy fields.')
    }
    const { contentType, contentId } = input
    const config = typeof contentType === 'string' && own(VALID_CONTENT_TYPES, contentType)
      ? VALID_CONTENT_TYPES[contentType] : null
    if (!config || typeof contentId !== 'string' || !VALID_ID.test(contentId)) {
      fail('invalid-argument', 'Choose a valid Writing or Mock assignment.')
    }
    const result = {
      contentType, contentId, ...config,
      sourceRef: db.doc(`${config.collection}/${contentId}`),
      policyRef: db.doc(`aiWritingSponsoredPolicies/${contentType}_${contentId}`)
    }
    if (!isWrite) return result
    if (typeof input.enabled !== 'boolean' || !Array.isArray(input.studentIds) ||
        input.studentIds.length > MAX_STUDENTS_PER_POLICY) {
      fail('invalid-argument', 'A boolean enabled and a limited student selection are required.')
    }
    const normalized = input.studentIds.slice().sort()
    if (normalized.some(id => typeof id !== 'string' || !VALID_STUDENT_ID.test(id)) ||
        new Set(normalized).size !== normalized.length ||
        (input.enabled && normalized.length === 0)) {
      fail('invalid-argument', 'Select unique, valid students before enabling automatic AI.')
    }
    return { ...result, enabled: input.enabled, studentIds: normalized }
  }

  function validStaff(profile, schoolId) {
    return profile && ['teacher', 'admin'].includes(profile.role) &&
      profile.status === 'approved' && profile.deleted !== true &&
      profile.archived !== true && profile.permanentDeleteInProgress !== true &&
      accountTypeOf(profile) === 'institution' && schoolIdOf(profile) === schoolId
  }

  function checkedSource(manager, source, config) {
    if (!source || source.deleted === true || source.archived === true ||
        schoolIdOf(source) !== PILOT_SCHOOL_ID ||
        !validStaff(manager.profile, PILOT_SCHOOL_ID) ||
        !managerCanManageSource(manager, source) ||
        (manager.profile.role === 'teacher' && !teacherOwnsSource(source, manager.uid))) {
      fail('permission-denied', 'You cannot configure AI assessment for this assignment.')
    }
    if (config.contentType === 'mock' &&
        (getMockEnabledSections(source)?.writing !== true ||
         typeof source.writingId !== 'string' || !VALID_ID.test(source.writingId))) {
      fail('failed-precondition', 'Mock Writing must be enabled and linked to a Writing resource.')
    }
  }

  function checkedLinkedWriting(linked, source, config) {
    if (config.contentType === 'mock' &&
        (!linked || linked.deleted === true || linked.archived === true ||
         schoolIdOf(linked) !== PILOT_SCHOOL_ID ||
         source.writingId === undefined)) {
      fail('failed-precondition', 'The linked Mock Writing resource is unavailable.')
    }
  }

  function checkedStudent(profile, access, studentId, manager, config, currentStudents) {
    if (!profile || profile.role !== 'student' || profile.status !== 'approved' ||
        profile.deleted === true || profile.archived === true ||
        profile.permanentDeleteInProgress === true ||
        accountTypeOf(profile) !== 'institution' ||
        schoolIdOf(profile) !== PILOT_SCHOOL_ID ||
        !access || access.uid !== studentId ||
        access.schoolId !== PILOT_SCHOOL_ID ||
        access.contentType !== config.contentType ||
        access.contentId !== config.contentId ||
        access.sourceCollection !== config.collection ||
        access.accessType !== 'assignment' || access.status !== 'active' ||
        access.adminHidden === true) {
      return false
    }
    // Legacy user.teacherIds / user.createdBy / studentAccess.assignedBy can be stale.
    // A teacher must own an active real class containing the student; school
    // admins may fund valid institutional assignments without a class.
    if (manager.profile.role === 'teacher' && !currentStudents?.has(studentId)) return false
    return true
  }

  function checkedStoredPolicy(policy, config) {
    if (!policy) return
    if (policy.schoolId !== PILOT_SCHOOL_ID ||
        policy.contentType !== config.contentType ||
        policy.contentId !== config.contentId ||
        policy.sourceCollection !== config.collection ||
        policy.context !== config.context ||
        !Array.isArray(policy.studentIds) ||
        policy.studentIds.length > MAX_STUDENTS_PER_POLICY ||
        policy.studentIds.some(uid => typeof uid !== 'string' || !VALID_STUDENT_ID.test(uid))) {
      fail('failed-precondition', 'Existing sponsored AI policy is inconsistent.')
    }
  }

  async function getPolicy(request) {
    const manager = await requireAssignmentManager(request)
    const config = parseInput(request, false)
    const [sourceSnap, schoolSnap, policySnap, managerSnap] = await Promise.all([
      config.sourceRef.get(), db.doc(`schools/${PILOT_SCHOOL_ID}`).get(),
      config.policyRef.get(), db.doc(`users/${manager.uid}`).get()
    ])
    const currentManager = { ...manager, profile: dataOf(managerSnap) }
    if (dataOf(schoolSnap)?.status !== 'active') {
      fail('failed-precondition', 'The institution is not active.')
    }
    const source = dataOf(sourceSnap)
    checkedSource(currentManager, source, config)
    if (config.contentType === 'mock') {
      const linked = await db.doc(`writingHomeworks/${source.writingId}`).get()
      checkedLinkedWriting(dataOf(linked), source, config)
    }
    const policy = dataOf(policySnap)
    checkedStoredPolicy(policy, config)
    const classes = currentManager.profile?.role === 'teacher'
      ? await teacherClassQuery(db, currentManager.uid).get() : null
    const currentStudents = currentTeacherStudents(classes, currentManager.uid)
    // Display effective policy, not a stale stored toggle. A revoked teacher
    // cannot leave the UI saying that an automatic paid report is enabled.
    let authorRole = ''
    let authorStudents = new Set()
    if (policy?.enabled === true && typeof policy.updatedBy === 'string' &&
        VALID_STUDENT_ID.test(policy.updatedBy)) {
      const author = dataOf(await db.doc(`users/${policy.updatedBy}`).get())
      if (validStaff(author, PILOT_SCHOOL_ID)) {
        if (author.role === 'admin') {
          authorRole = 'admin'
        } else if (teacherOwnsSource(source, policy.updatedBy)) {
          const authorClasses = policy.updatedBy === currentManager.uid && classes
            ? classes : await teacherClassQuery(db, policy.updatedBy).get()
          authorRole = 'teacher'
          authorStudents = currentTeacherStudents(authorClasses, policy.updatedBy)
        }
      }
    }
    const ids = policy?.studentIds || []
    const studentIds = []
    if (ids.length) {
      const refs = ids.flatMap(uid => [
        db.doc(`users/${uid}`),
        db.doc(`studentAccess/${uid}_${config.contentType}_${config.contentId}`)
      ])
      const snaps = await db.getAll(...refs)
      for (let i = 0; i < ids.length; i++) {
        if (checkedStudent(dataOf(snaps[2 * i]), dataOf(snaps[2 * i + 1]),
          ids[i], currentManager, config, currentStudents) &&
          (policy?.enabled !== true || authorRole === 'admin' ||
           (authorRole === 'teacher' && authorStudents.has(ids[i])))) studentIds.push(ids[i])
      }
    }
    return {
      ok: true, contentType: config.contentType, contentId: config.contentId,
      enabled: policy?.enabled === true && studentIds.length > 0,
      studentIds,
      configured: Boolean(policy),
      billing: 'institution',
      // Deliberately OFF in P5B-3A. No automatic evaluation trigger exists yet.
      autoEvaluationLive: false
    }
  }

  async function setPolicy(request) {
    const manager = await requireAssignmentManager(request)
    const config = parseInput(request, true)
    const schoolRef = db.doc(`schools/${PILOT_SCHOOL_ID}`)
    const managerRef = db.doc(`users/${manager.uid}`)
    const userRefs = config.studentIds.map(uid => db.doc(`users/${uid}`))
    const accessRefs = config.studentIds.map(uid =>
      db.doc(`studentAccess/${uid}_${config.contentType}_${config.contentId}`))
    return db.runTransaction(async tx => {
      const sourceSnap = await tx.get(config.sourceRef)
      const source = dataOf(sourceSnap)
      // Early abort before any policy grant or student data is read/written.
      checkedSource(manager, source, config)
      const linkedRef = config.contentType === 'mock'
        ? db.doc(`writingHomeworks/${source.writingId}`) : null
      const classQuery = manager.profile.role === 'teacher'
        ? teacherClassQuery(db, manager.uid) : null
      const refs = [managerRef, schoolRef, config.policyRef,
        ...(linkedRef ? [linkedRef] : []), ...userRefs, ...accessRefs,
        ...(classQuery ? [classQuery] : [])]
      const snaps = await Promise.all(refs.map(ref => tx.get(ref)))
      const freshManager = { uid: manager.uid, profile: dataOf(snaps[0]) }
      if (dataOf(snaps[1])?.status !== 'active') {
        fail('failed-precondition', 'The institution must be active.')
      }
      checkedSource(freshManager, source, config)
      checkedStoredPolicy(dataOf(snaps[2]), config)
      const offset = linkedRef ? 4 : 3
      if (linkedRef) checkedLinkedWriting(dataOf(snaps[3]), source, config)
      const classes = classQuery ? snaps[snaps.length - 1] : null
      const currentStudents = currentTeacherStudents(classes, freshManager.uid)
      for (let i = 0; i < config.studentIds.length; i++) {
        const profile = dataOf(snaps[offset + i])
        const access = dataOf(snaps[offset + userRefs.length + i])
        if (!checkedStudent(profile, access, config.studentIds[i], freshManager, config, currentStudents)) {
          fail('permission-denied', 'Only currently assigned institution students may be selected.')
        }
      }
      // Policy set happens after all Firestore reads, atomically and without credits.
      tx.set(config.policyRef, {
        schemaVersion: SCHEMA_VERSION,
        schoolId: PILOT_SCHOOL_ID,
        contentType: config.contentType,
        contentId: config.contentId,
        context: config.context,
        sourceCollection: config.collection,
        enabled: config.enabled,
        studentIds: config.studentIds,
        billing: 'institution',
        updatedBy: manager.uid,
        updatedAt: FieldValue.serverTimestamp(),
        ...(!snaps[2].exists ? { createdAt: FieldValue.serverTimestamp() } : {})
      }, { merge: true })
      return {
        ok: true, contentType: config.contentType, contentId: config.contentId,
        enabled: config.enabled, selectedCount: config.studentIds.length,
        billing: 'institution', autoEvaluationLive: false
      }
    })
  }

  return { getPolicy, setPolicy }
}

module.exports = {
  createAiWritingSponsoredPolicyService,
  MAX_STUDENTS_PER_POLICY,
  PILOT_SCHOOL_ID
}
