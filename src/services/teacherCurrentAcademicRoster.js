// P0-B2B. Teacher academic students come ONLY from the server-authored
// current class membership index. Historic teacher metadata is not ACL.
import { doc, onSnapshot } from 'firebase/firestore'

const MAX_MEMBERS = 250
const validUid = id => typeof id === 'string' && id.length > 0 &&
  id.length <= 128 && id.trim() === id && !id.includes('/')

export function subscribeCurrentTeacherAcademicRoster(db, schoolId, teacherId, onStudents, onStatus = () => {}) {
  if (typeof onStudents !== 'function' || typeof onStatus !== 'function') {
    throw new Error('Invalid roster callbacks')
  }
  let closed = false
  let epoch = 0
  let unsubStudents = []
  const clearStudents = () => {
    unsubStudents.forEach(stop => stop())
    unsubStudents = []
  }
  const publishEmpty = status => {
    if (closed) return
    onStudents([])
    onStatus(status)
  }
  publishEmpty('loading')
  if (!validUid(teacherId) || !validUid(schoolId)) {
    publishEmpty('error')
    return () => {closed = true}
  }

  // Firestore onSnapshot error callbacks are terminal. A server-side repair
  // does not revive the old listener; resubscribe conservatively, fail closed.
  let unsubIndex = () => {}
  let retryTimer = null
  let retryDelayMs = 0
  const scheduleRetry = () => {
    if (closed || retryTimer !== null) return
    retryDelayMs = retryDelayMs ? Math.min(retryDelayMs * 2, 15000) : 350
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (closed) return
      ++epoch
      clearStudents()
      unsubIndex()
      listenIndex()
    }, retryDelayMs)
  }
  const listenIndex = () => {
    if (closed) return
    unsubIndex = onSnapshot(
    doc(db, 'schools', schoolId, 'teacherAcademicIndex', teacherId),
    { includeMetadataChanges: true },
    snapshot => {
      if (closed) return
      if (snapshot.metadata?.fromCache === true) {
        ++epoch
        clearStudents()
        publishEmpty('loading')
        return
      }
      const current = ++epoch
      clearStudents()
      publishEmpty('loading')
      const index = snapshot.exists() ? snapshot.data() : null
      const ids = index?.activeStudentIds
      const valid = index?.schemaVersion === 1 &&
        index?.source === 'managed_active_classes' &&
        index?.teacherId === teacherId && index?.schoolId === schoolId &&
        Array.isArray(ids) && ids.length <= MAX_MEMBERS &&
        ids.every(validUid) && new Set(ids).size === ids.length
      if (!valid) {
        publishEmpty('error')
        return
      }
      if (ids.length === 0) {
        retryDelayMs = 0
        publishEmpty('ready')
        return
      }
      const profiles = new Map()
      const received = new Set()
      let failed = false
      const publish = () => {
        if (closed || epoch !== current) return
        if (failed) {
          publishEmpty('error')
          return
        }
        if (received.size !== ids.length) return
        const result = [...profiles.values()].sort((a,b) =>
          (a.name || a.email || '').localeCompare(b.name || b.email || ''))
        onStudents(result)
        onStatus('ready')
        retryDelayMs = 0
      }
      unsubStudents = ids.map(studentId => onSnapshot(
        doc(db,'users',studentId),
        { includeMetadataChanges: true },
        studentSnap => {
          if (closed || epoch !== current) return
          if (studentSnap.metadata?.fromCache === true) {
            profiles.delete(studentId)
            received.delete(studentId)
            publishEmpty('loading')
            return
          }
          const student = studentSnap.exists()
            ? {...studentSnap.data(), id:studentId} : null
          const eligible = student?.role === 'student' &&
            student.status === 'approved' && student.deleted !== true &&
            student.archived !== true && student.permanentDeleteInProgress !== true &&
            student.accountType !== 'individual' && student.schoolId !== '__individual__' &&
            (student.schoolId || 'maxima') === schoolId
          if (eligible) profiles.set(studentId,student)
          else profiles.delete(studentId)
          received.add(studentId)
          publish()
        },
        error => {
          if (closed || epoch !== current) return
          // Do not accidentally present a partial roster as complete.
          console.warn('Academic roster student unavailable:',error?.code || 'unknown')
          failed = true
          ++epoch
          clearStudents()
          publishEmpty('error')
          scheduleRetry()
        }
      ))
    },
    error => {
      if (closed) return
      ++epoch
      clearStudents()
      console.warn('Academic roster index unavailable:',error?.code || 'unknown')
      publishEmpty('error')
      scheduleRetry()
    }
    )
  }
  listenIndex()
  return () => {
    closed = true
    ++epoch
    if (retryTimer !== null) clearTimeout(retryTimer)
    unsubIndex()
    clearStudents()
  }
}
