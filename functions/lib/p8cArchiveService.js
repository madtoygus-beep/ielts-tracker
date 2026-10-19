'use strict'

// P8-C: Read-only, owner-scoped summary of work removed from an assignment.
// Never send answer keys, questions, submission snapshots or AI raw reports.
const ARCHIVE_COLLECTIONS = Object.freeze({
  reading: { source: 'readings', submissions: 'readingSubmissions', ids: ['readingId'] },
  listening: { source: 'listenings', submissions: 'listeningSubmissions', ids: ['listeningId'] },
  writing: { source: 'writingHomeworks', submissions: 'writingSubmissions', ids: ['writingId'] },
  vocabulary: { source: 'vocabularyTests', submissions: 'vocabularySubmissions',
    ids: ['vocabularyTestId','vocabularyId','testId','homeworkId'] },
  mock: { source: 'mockTests', submissions: 'mockSubmissions', ids: ['mockTestId'] }
})
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(id)

function createP8CArchiveService({
  db, HttpsError, requireStudent, schoolIdOf, getStudentOwnedResultSnapshots,
  studentResultSafeBase, studentResultMatchesOwner, studentAttemptHistoryMatches,
  studentScoreContentId, readSavedWritingAi
}) {
  async function list(request) {
    const student = await requireStudent(request)
    // requireStudent validates role/school, but older approved profiles can
    // separately be archived or be in a permanent-delete workflow.
    if (!student?.profile || student.profile.status !== 'approved' ||
        student.profile.deleted === true || student.profile.archived === true ||
        student.profile.permanentDeleteInProgress === true) {
      throw new HttpsError('permission-denied', 'This student account cannot view archived results.')
    }
    const input = request?.data || {}
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => key !== 'contentType') ||
        !own(ARCHIVE_COLLECTIONS, input.contentType)) {
      throw new HttpsError('invalid-argument', 'Choose a valid archived result category.')
    }
    const category = input.contentType
    const config = ARCHIVE_COLLECTIONS[category]
    const accessSnap = await db.collection('studentAccess')
      .where('uid','==',student.uid)
      .where('schoolId','==',student.schoolId).get()
    const archiveAccess = accessSnap.docs.map(snap => snap.data() || {})
      .filter(access => access.uid === student.uid &&
        access.accessType === 'unassigned_archive' && access.status === 'inactive' &&
        access.contentType === category && access.sourceCollection === config.source &&
        schoolIdOf(access) === student.schoolId && access.adminHidden !== true &&
        safeId(access.contentId))
    if (!archiveAccess.length) return { ok: true, contentType: category, items: [] }
    if (archiveAccess.length > 300) {
      throw new HttpsError('resource-exhausted', 'Archive is too large. Ask your school to export older results.')
    }
    // Confirm original content still belongs to this school and is available.
    // Archived/hidden sources must not leak through this separate route.
    const validIds = new Map()
    for (let start = 0; start < archiveAccess.length; start += 100) {
      const group = archiveAccess.slice(start, start + 100)
      const snaps = await db.getAll(...group.map(access => db.doc(`${config.source}/${access.contentId}`)))
      snaps.forEach((snap, index) => {
        if (!snap?.exists) return
        const source = snap.data() || {}
        if (source.archived === true || source.deleted === true ||
            schoolIdOf(source) !== student.schoolId) return
        const access = group[index]
        validIds.set(access.contentId, {
          source,
          contentId: access.contentId,
          title: typeof source.title === 'string' ? source.title.slice(0, 250) : '',
          removedAt: typeof access.unassignedAt?.toDate === 'function'
            ? access.unassignedAt.toDate().toISOString()
            : typeof access.unassignedAt === 'string' ? access.unassignedAt.slice(0, 40) : ''
        })
      })
    }
    if (!validIds.size) return { ok: true, contentType: category, items: [] }

    const results = await getStudentOwnedResultSnapshots(config.submissions, student)
    const byKey = new Map()
    const writingAiCandidates = []
    const add = (record, contentId, attemptNumber = 1) => {
      if (!validIds.has(contentId) || !record ||
          !studentResultMatchesOwner(record, student.uid, student.schoolId)) return
      const safe = studentResultSafeBase('', record, category)
      const delivered = Boolean(safe.submittedAt || safe.reviewed === true || safe.result ||
        ['submitted','completed','graded'].includes(safe.status))
      if (!delivered) return // No archived draft or unsubmitted answer exposure.
      const num = Number(attemptNumber)
      if (!Number.isSafeInteger(num) || num < 1 || num > 1000) return
      const entry = validIds.get(contentId)
      const item = {
        contentType: category, contentId, title: entry.title || `${category} assignment`,
        removedAt: entry.removedAt, attemptNumber: num,
        submittedAt: safe.submittedAt || safe.date || safe.createdAt || '',
        reviewed: safe.reviewed === true,
        result: safe.result || null,
        // For read-only historic display, teacher feedback is allowed but raw
        // submission answers and model evidence are intentionally omitted.
        review: safe.review || safe.writingReview || null,
        excludedFromStats: safe.excludedFromStats === true
      }
      const key = `${contentId}\u001f${num}`
      const old = byKey.get(key)
      if (!old || (!old.reviewed && item.reviewed)) byKey.set(key, item)
    }
    for (const row of results) {
      const record = row.data || {}
      for (const field of config.ids) {
        if (validIds.has(record[field])) {
          add(record, record[field], record.attemptNumber || 1)
          if (category === 'writing' && typeof readSavedWritingAi === 'function') {
            writingAiCandidates.push({ record, contentId: record[field],
              attemptNumber: Number(record.attemptNumber || 1), submissionId: row.id })
          }
          break
        }
      }
    }
    const histories = await db.collection('submissionAttemptHistory')
      .where('studentId','==',student.uid).get()
    for (const snap of histories.docs) {
      const history = snap.data() || {}
      if (!validIds.has(history.contentId) ||
          !studentAttemptHistoryMatches({
            contentType: category, sourceCollection: config.source,
            submissionCollection: config.submissions
          }, history, student.uid, student.schoolId)) continue
      const record = history.submissionSnapshot || {}
      // Immutable attempt snapshots must still prove individual ownership.
      if (record.uid !== student.uid || record.studentId !== student.uid ||
          schoolIdOf(record) !== student.schoolId) continue
      add(record, history.contentId, history.attemptNumber)
      if (category === 'writing' && typeof readSavedWritingAi === 'function') {
        writingAiCandidates.push({ record, contentId: history.contentId,
          attemptNumber: Number(history.attemptNumber), submissionId: history.sourceSubmissionId || '' })
      }
    }
    if (category === 'mock') {
      const scores = await getStudentOwnedResultSnapshots('scores', student)
      for (const row of scores) {
        const record = row.data || {}
        const id = studentScoreContentId(record)
        if (validIds.has(id) && !byKey.has(`${id}\u001f${record.attemptNumber || 1}`)) {
          add(record, id, record.attemptNumber || 1)
        }
      }
    }
    // Exactly matched, already-saved Writing AI bands may appear as a
    // read-only headline. This helper NEVER calls a provider, spends credits,
    // or sends student answers. Invalid fingerprints yield no band.
    for (let start = 0; start < Math.min(writingAiCandidates.length, 100); start += 10) {
      const batch = writingAiCandidates.slice(start, start + 10)
      const reports = await Promise.allSettled(batch.map(entry => {
        const item = validIds.get(entry.contentId)
        return readSavedWritingAi({ student, source: item?.source,
          contentId: entry.contentId, attemptNumber: entry.attemptNumber,
          submission: entry.record, submissionId: entry.submissionId })
      }))
      reports.forEach((report, index) => {
        if (report.status !== 'fulfilled' || report.value?.status !== 'completed') return
        const entry = batch[index]
        const item = byKey.get(`${entry.contentId}\u001f${entry.attemptNumber}`)
        if (item && (typeof report.value.estimatedBand === 'number' ||
            report.value.estimatedBand === null && report.value.feedbackOnly === true)) {
          item.aiEstimatedBand = report.value.estimatedBand
          item.aiFeedbackOnly = report.value.feedbackOnly === true
        }
      })
    }
    const items = [...byKey.values()].sort((a, b) => {
      const time = value => {
        if (typeof value === 'string') return Date.parse(value) || 0
        if (value && typeof value.seconds === 'number') return value.seconds * 1000
        return 0
      }
      return time(b.submittedAt) - time(a.submittedAt) || b.attemptNumber - a.attemptNumber
    }).slice(0, 100)
    return { ok: true, contentType: category, items }
  }
  return { list }
}
module.exports = { ARCHIVE_COLLECTIONS, createP8CArchiveService }
