// P5B-3B: UI-only policy helpers. The Firebase callable validates all permissions.
export const AI_SPONSORED_SCHOOL_ID = 'maxima'
export const MAX_AI_SPONSORED_STUDENTS = 60
const STUDENT_UID = /^[A-Za-z0-9_-]{6,128}$/

export function emptyAiSponsoredSelection() {
  return { enabled: false, studentIds: [], configured: false }
}

export function normalizeAiSponsoredPolicy(response, expectedContentType, expectedContentId) {
  if (!response || response.ok !== true ||
      response.contentType !== expectedContentType ||
      response.contentId !== expectedContentId ||
      response.billing !== 'institution' ||
      !Array.isArray(response.studentIds)) {
    throw new Error('The AI assessment settings could not be verified.')
  }
  const studentIds = response.studentIds
  if (studentIds.length > MAX_AI_SPONSORED_STUDENTS ||
      studentIds.some(id => typeof id !== 'string' || !STUDENT_UID.test(id)) ||
      new Set(studentIds).size !== studentIds.length) {
    throw new Error('The AI student selection is invalid.')
  }
  return {
    enabled: response.enabled === true && studentIds.length > 0,
    studentIds,
    configured: response.configured === true
  }
}

export function eligibleAiSponsoredStudents(students, assignedIds) {
  const assigned = new Set(Array.isArray(assignedIds) ? assignedIds : [])
  return (Array.isArray(students) ? students : []).filter(student =>
    student && assigned.has(student.id) &&
    typeof student.id === 'string' && STUDENT_UID.test(student.id) &&
    student.role === 'student' && student.status === 'approved' &&
    student.deleted !== true && student.archived !== true &&
    student.permanentDeleteInProgress !== true &&
    student.accountType !== 'individual' &&
    student.schoolId !== '__individual__' &&
    (student.schoolId || AI_SPONSORED_SCHOOL_ID) === AI_SPONSORED_SCHOOL_ID
  )
}

export function buildAiSponsoredWriteRequest({
  contentType, contentId, selection, assignedStudentIds
}) {
  if (!['writing', 'mock'].includes(contentType) ||
      typeof contentId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(contentId)) {
    throw new Error('A valid saved Writing or Mock assignment is required.')
  }
  const enabled = selection?.enabled === true
  if (!enabled) return { contentType, contentId, enabled: false, studentIds: [] }
  const allowed = new Set(Array.isArray(assignedStudentIds) ? assignedStudentIds : [])
  const ids = Array.isArray(selection?.studentIds) ? selection.studentIds : []
  const studentIds = [...new Set(ids.filter(id => allowed.has(id) && STUDENT_UID.test(id)))].sort()
  if (studentIds.length > MAX_AI_SPONSORED_STUDENTS) {
    throw new Error(`Select at most ${MAX_AI_SPONSORED_STUDENTS} students for AI assessment.`)
  }
  if (enabled && studentIds.length === 0) {
    throw new Error('Select at least one assigned student for automatic AI assessment.')
  }
  return {
    contentType,
    contentId,
    enabled,
    studentIds: enabled ? studentIds : []
  }
}

// Normal edits must not create an AI policy when the teacher did not opt in.
// This also avoids breaking ordinary saves while the AI backend is undeployed.
export function shouldSaveAiSponsoredPolicy({ selection, ready, schoolId, hasWriting = true }) {
  return ready === true && schoolId === AI_SPONSORED_SCHOOL_ID && hasWriting &&
    (selection?.enabled === true || selection?.configured === true)
}

export function shouldRetireMockAiSponsoredPolicy({
  isEditMode, existingMock, wasWritingEnabled, newWritingId, newWritingEnabled, configured, ready
}) {
  if (!isEditMode || !configured || !ready || !existingMock) return false
  return wasWritingEnabled === true &&
    (!newWritingEnabled || newWritingId !== existingMock.writingId)
}
