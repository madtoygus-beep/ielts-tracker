const band = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9 ? value : null
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
// Use the latest attempt per learner and assignment for averages; keep retakes in the history.
export function speakingAnalytics(data, { staff = false, studentId = '', allowedStudentIds = [] } = {}) {
  const allowed = new Set(allowedStudentIds)
  const attempts = [...new Map(data.attempts.filter(attempt => !staff || (allowed.has(attempt.studentId) && (!studentId || attempt.studentId === studentId))).map(attempt => [attempt.id, attempt])).values()]
    .sort((a,b) => Number(b.startedAt) - Number(a.startedAt) || b.id.localeCompare(a.id))
  const latest = new Map()
  for (const attempt of attempts) {
    const key = JSON.stringify([staff ? attempt.studentId : '', attempt.mockId || attempt.taskId, Boolean(attempt.mockId)])
    if (!latest.has(key)) latest.set(key, attempt)
  }
  const latestSubmitted = new Map()
  for (const attempt of attempts.filter(attempt => ['submitted', 'reviewed'].includes(attempt.status))) {
    const key = JSON.stringify([staff ? attempt.studentId : '', attempt.mockId || attempt.taskId, Boolean(attempt.mockId)])
    if (!latestSubmitted.has(key)) latestSubmitted.set(key, attempt)
  }
  const submitted = [...latestSubmitted.values()]
  const teacherBands = submitted.map(attempt => band(attempt.review?.band)).filter(value => value !== null)
  const aiBands = submitted.map(attempt => band(attempt.report?.estimatedBand)).filter(value => value !== null)
  let assigned = 0, completed = 0
  for (const task of new Map(data.tasks.filter(task => !task.archived).map(task => [task.id, task])).values()) {
    const recipients = staff ? (task.assignedTo || []).filter(id => allowed.has(id) && (!studentId || id === studentId)) : ['']
    for (const recipient of new Set(recipients)) {
      assigned++
      const attempt = latest.get(JSON.stringify([recipient, task.id, false]))
      if (['submitted','reviewed'].includes(attempt?.status)) completed++
    }
  }
  return { assigned, completed, teacherAverage: average(teacherBands), teacherCount: teacherBands.length,
    aiAverage: average(aiBands), aiCount: aiBands.length,
    history: attempts.filter(attempt => ['submitted','reviewed'].includes(attempt.status)) }
}
