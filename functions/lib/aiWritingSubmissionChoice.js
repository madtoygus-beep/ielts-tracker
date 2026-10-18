'use strict'

// Read-only, server-authoritative AI option for the CURRENT institutional
// Writing assignment. Never starts a model call or spends any quota/credit.
const { teacherClassQuery, currentTeacherStudents, teacherOwnsSource } = require('./aiWritingTeacherRelationship')

const SCHOOL_ID = 'maxima'
const ID = /^[A-Za-z0-9_-]{1,150}$/
const UID = /^[A-Za-z0-9_-]{6,128}$/
const dataOf = snapshot => snapshot?.exists ? (snapshot.data() || {}) : null
const validPositiveInteger = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000
const validStaff = (staff, schoolIdOf, accountTypeOf) => staff &&
  ['teacher','admin'].includes(staff.role) && staff.status === 'approved' &&
  staff.deleted !== true && staff.archived !== true &&
  staff.permanentDeleteInProgress !== true &&
  schoolIdOf(staff) === SCHOOL_ID && accountTypeOf(staff) === 'institution'

function createAiWritingSubmissionChoiceService({
  db, HttpsError, requireStudent, schoolIdOf, accountTypeOf,
  providerEnabled = () => false, sponsoredEnabled = () => false
}) {
  if (![db, HttpsError, requireStudent, schoolIdOf, accountTypeOf].every(Boolean)) {
    throw new Error('AI submission choice dependencies are missing.')
  }
  const fail = (code, msg) => { throw new HttpsError(code, msg) }
  const disabled = reason => ({ canChooseAi: false, institutionFunded: false,
    billingMode: 'none', creditsRemaining: 0, reason })

  async function getOptionsForStudent(student, contentId) {
    if (typeof contentId !== 'string' || !ID.test(contentId) ||
        !student?.uid || !UID.test(student.uid)) {
      fail('invalid-argument', 'Choose a valid Writing assignment.')
    }
    const uid = student.uid
    const [userSnap, schoolSnap, sourceSnap, assignmentSnap, settingsSnap,
      creditSnap, policySnap] = await Promise.all([
      db.doc(`users/${uid}`).get(),
      db.doc(`schools/${SCHOOL_ID}`).get(),
      db.doc(`writingHomeworks/${contentId}`).get(),
      db.doc(`studentAccess/${uid}_writing_${contentId}`).get(),
      db.doc(`aiWritingSchoolSettings/${SCHOOL_ID}`).get(),
      db.doc(`aiWritingStudentAccess/${uid}`).get(),
      db.doc(`aiWritingSponsoredPolicies/writing_${contentId}`).get()
    ])
    const user = dataOf(userSnap)
    const school = dataOf(schoolSnap)
    const source = dataOf(sourceSnap)
    const assignment = dataOf(assignmentSnap)
    const settings = dataOf(settingsSnap)
    const credit = dataOf(creditSnap)
    const policy = dataOf(policySnap)

    // Never leak another student's availability, assignment or AI balance.
    if (!user || user.role !== 'student' || user.status !== 'approved' ||
        user.deleted === true || user.archived === true ||
        user.permanentDeleteInProgress === true ||
        accountTypeOf(user) !== 'institution' || schoolIdOf(user) !== SCHOOL_ID ||
        student.schoolId !== SCHOOL_ID || school?.status !== 'active' ||
        !source || source.deleted === true || source.archived === true ||
        schoolIdOf(source) !== SCHOOL_ID ||
        !assignment || assignment.uid !== uid ||
        assignment.schoolId !== SCHOOL_ID ||
        assignment.contentType !== 'writing' || assignment.contentId !== contentId ||
        assignment.sourceCollection !== 'writingHomeworks' ||
        assignment.accessType !== 'assignment' || assignment.status !== 'active' ||
        assignment.adminHidden === true) {
      fail('permission-denied', 'This Writing assignment is not available to this student.')
    }

    // Both evaluation paths stay disabled while the institution pilot is OFF.
    if (settings?.schoolId !== SCHOOL_ID || settings.pilotEnabled !== true) {
      return disabled('pilot_off')
    }
    const creditCount = credit?.uid === uid && credit.studentId === uid &&
      credit.schoolId === SCHOOL_ID && credit.accountType === 'institution' &&
      credit.enabled === true && validPositiveInteger(credit.creditsRemaining)
      ? credit.creditsRemaining : 0

    let funded = false
    if (sponsoredEnabled() === true &&
        policy?.schoolId === SCHOOL_ID && policy.enabled === true &&
        policy.contentType === 'writing' && policy.contentId === contentId &&
        policy.context === 'homework' && policy.sourceCollection === 'writingHomeworks' &&
        policy.billing === 'institution' &&
        Array.isArray(policy.studentIds) && policy.studentIds.length > 0 &&
        policy.studentIds.length <= 60 &&
        policy.studentIds.every(id => typeof id === 'string' && UID.test(id)) &&
        new Set(policy.studentIds).size === policy.studentIds.length &&
        policy.studentIds.includes(uid) && typeof policy.updatedBy === 'string' &&
        UID.test(policy.updatedBy)) {
      const managerId = policy.updatedBy
      const managerSnap = await db.doc(`users/${managerId}`).get()
      const manager = dataOf(managerSnap)
      if (validStaff(manager, schoolIdOf, accountTypeOf)) {
        if (manager.role === 'admin') {
          funded = true
        } else if (teacherOwnsSource(source, managerId)) {
          const classes = await teacherClassQuery(db, managerId).get()
          funded = currentTeacherStudents(classes, managerId).has(uid)
        }
      }
    }
    // Institution-sponsored rights take precedence: no student credit deducted.
    const canUse = providerEnabled() === true
    return {
      canChooseAi: canUse && (funded || creditCount > 0),
      institutionFunded: canUse && funded,
      billingMode: canUse ? (funded ? 'institution' : creditCount > 0 ? 'student_credit' : 'none') : 'none',
      creditsRemaining: creditCount,
      reason: !canUse ? 'provider_off' : funded || creditCount > 0 ? 'ready' : 'no_credits'
    }
  }

  async function getMyOptions(request) {
    const data = request?.data || {}
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).some(key => key !== 'contentId')) {
      fail('invalid-argument', 'Only a Writing contentId may be requested.')
    }
    const student = await requireStudent(request)
    return getOptionsForStudent(student, data.contentId)
  }
  return { getMyOptions, getOptionsForStudent }
}

module.exports = { createAiWritingSubmissionChoiceService }
