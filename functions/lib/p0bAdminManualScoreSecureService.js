'use strict'
// P0-B2B admin-only manual IELTS scores. This service never trusts client
// school, actor, provenance, overall, mock or teacher ownership fields.
const crypto = require('node:crypto')

const INPUT_KEYS = Object.freeze([
  'studentId', 'date', 'listening', 'reading', 'writing', 'speaking', 'requestId'
])
const BANDS = Object.freeze(['listening', 'reading', 'writing', 'speaking'])
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STUDENT_ID = /^[^/\x00-\x1f\x7f\s][^/\x00-\x1f\x7f]{0,127}$/
const SCHOOL_ID = /^[a-z0-9][a-z0-9-]{1,62}$/
const BAND_TEXT = /^[0-9](?:\.[05])?$/
const own = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.getPrototypeOf(obj) === Object.prototype &&
  Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key))

function isActiveUser(profile, role) {
  return profile && profile.role === role && profile.status === 'approved' &&
    profile.deleted !== true && profile.archived !== true &&
    profile.permanentDeleteInProgress !== true
}

function parseBand(value) {
  const raw = typeof value === 'number' && Number.isFinite(value)
    ? String(value) : value
  if (typeof raw !== 'string' || !BAND_TEXT.test(raw)) return null
  const number = Number(raw)
  if (!Number.isFinite(number) || number < 0 || number > 9 ||
    !Number.isInteger(number * 2)) return null
  return number.toFixed(1)
}

function validScoreDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  if (year < 1900 || year > 2100) return false
  const date = new Date(value + 'T00:00:00.000Z')
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function createAdminManualScoreSecureService({db, HttpsError, requireAdmin, schoolIdOf}) {
  const fail = (code, message) => { throw new HttpsError(code, message) }
  if (!db || typeof db.runTransaction !== 'function' ||
      typeof requireAdmin !== 'function' || typeof schoolIdOf !== 'function') {
    throw Error('ADMIN_MANUAL_SCORE_DEPENDENCIES_INVALID')
  }

  return async function createAdminManualScoreSecure(request) {
    // Uses canonical server-side staff profile, not a client-provided role.
    const admin = await requireAdmin(request)
    if (!admin || typeof admin.uid !== 'string' || !isActiveUser(admin.profile, 'admin')) {
      fail('permission-denied', 'An active administrator is required.')
    }
    const data = request.data
    if (!own(data, INPUT_KEYS)) {
      fail('invalid-argument', 'Exactly the manual IELTS score fields are required.')
    }
    const studentId = data.studentId
    if (typeof studentId !== 'string' || studentId.trim() !== studentId ||
        !STUDENT_ID.test(studentId)) {
      fail('invalid-argument', 'A canonical student document ID is required.')
    }
    if (!validScoreDate(data.date)) fail('invalid-argument', 'The IELTS score date is invalid.')
    if (!UUID_V4.test(data.requestId)) {
      fail('invalid-argument', 'A valid unique submission request ID is required.')
    }
    const grades = {}
    for (const name of BANDS) {
      const grade = parseBand(data[name])
      if (grade === null) fail('invalid-argument', 'Invalid IELTS ' + name + ' band.')
      grades[name] = grade
    }
    const mean = BANDS.reduce((sum, name) => sum + Number(grades[name]), 0) / 4
    const overall = (Math.round(mean * 2) / 2).toFixed(1)
    const key = crypto.createHash('sha256').update(admin.uid + ':' + data.requestId).digest('hex')
    const scoreRef = db.doc('scores/adminManual_' + key)
    const actorRef = db.doc('users/' + admin.uid)
    const studentRef = db.doc('users/' + studentId)

    // Every authoritative check and the create occur within one transaction.
    // Replays cannot create duplicates or overwrite another score.
    return db.runTransaction(async tx => {
      const [actorSnap, studentSnap, existingSnap] = await Promise.all([
        tx.get(actorRef), tx.get(studentRef), tx.get(scoreRef)
      ])
      const actor = actorSnap.exists ? actorSnap.data() || {} : null
      const student = studentSnap.exists ? studentSnap.data() || {} : null
      if (!isActiveUser(actor, 'admin')) {
        fail('permission-denied', 'Administrator access was revoked.')
      }
      const institutionalAccount = student && (student.accountType === undefined ||
        student.accountType === null ||
        (typeof student.accountType === 'string' &&
          student.accountType.trim().toLowerCase() === 'institution'))
      if (!isActiveUser(student, 'student') || !institutionalAccount ||
          student.schoolId === '__individual__') {
        fail('failed-precondition', 'The selected student is not an active institutional learner.')
      }
      const schoolId = schoolIdOf(student)
      if (typeof schoolId !== 'string' || !SCHOOL_ID.test(schoolId)) {
        fail('failed-precondition', 'Student school identity is invalid.')
      }
      const schoolSnap = await tx.get(db.doc('schools/' + schoolId))
      const school = schoolSnap.exists ? schoolSnap.data() || {} : null
      if (!school || school.status !== 'active' || school.deleteInProgress === true) {
        fail('failed-precondition', 'The student institution is not active.')
      }
      const record = {
        uid: studentId,
        studentId,
        schoolId,
        // Admin actions must NOT claim the historical or current teacher as actor.
        teacherId: '',
        teacherIds: [],
        addedBy: admin.uid,
        source: 'manual',
        date: data.date,
        listening: grades.listening,
        reading: grades.reading,
        writing: grades.writing,
        speaking: grades.speaking,
        overall
      }
      if (existingSnap.exists) {
        const existing = existingSnap.data() || {}
        if (Object.keys(record).every(k => JSON.stringify(existing[k]) === JSON.stringify(record[k])) &&
            Object.keys(existing).length === Object.keys(record).length) {
          return {ok:true, scoreId:scoreRef.id, replayed:true}
        }
        fail('already-exists', 'This request ID already belongs to another score.')
      }
      tx.create(scoreRef, record)
      return {ok:true, scoreId:scoreRef.id, replayed:false}
    })
  }
}

module.exports = {createAdminManualScoreSecureService}
