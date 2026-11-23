// Consume the authenticated Speaking API; never read private collections from the browser.
export async function loadSpeakingHomework(api) {
  const first = await api('list', { staff: false })
  const data = { tasks: [...first.tasks], attempts: [...first.attempts] }
  await Promise.all(['tasks', 'attempts'].map(async kind => {
    let cursor = first.cursors?.[kind]
    const seen = new Set()
    while (cursor) {
      if (seen.has(cursor)) throw Error('Speaking pagination could not be completed. Please refresh.')
      seen.add(cursor)
      const page = await api('list', { staff: false, kind, cursors: { [kind]: cursor } })
      data[kind].push(...page[kind])
      cursor = page.cursors?.[kind]
    }
  }))
  return speakingHomeworkSummary(data)
}

export function studentSpeakingAssignments({ tasks, attempts }) {
  const latest = new Map(), byId = new Map()
  for (const attempt of attempts) {
    if (attempt.mockId || !attempt.taskId) continue
    byId.set(attempt.id, attempt)
    const previous = latest.get(attempt.taskId)
    if (!previous || Number(attempt.startedAt) > Number(previous.startedAt) ||
        (attempt.startedAt === previous.startedAt && attempt.status !== 'recording')) {
      latest.set(attempt.taskId, attempt)
    }
  }
  const assigned = [...new Map(tasks.filter(t => !t.archived).map(t => [t.id, t])).values()]
  return assigned.map(task => {
    // Prefer the current server head to an older cached attempt, including after teacher resets.
    const canonical = Object.hasOwn(task, 'latestAttemptId') || Object.hasOwn(task, 'latestAttemptStatus')
    const attempt = canonical ? byId.get(task.latestAttemptId) : latest.get(task.id)
    const status = canonical ? task.latestAttemptStatus || '' : attempt?.status || ''
    const reportId = canonical ? task.latestAttemptId || '' : attempt?.id || ''
    return { ...task, type: 'Speaking', icon: '🎙️', color: 'indigo',
      path: `/speaking?task=${encodeURIComponent(task.id)}`,
      isRetake: task.retakeAvailable === true,
      retakeState: task.retakeAvailable ? { nextAttemptNumber: task.nextAttemptNumber || 2 } : null,
      attemptId: !task.retakeAvailable && status === 'recording' ? reportId : null,
      done: !task.retakeAvailable && ['submitted', 'reviewed'].includes(status), reportId, attempt, status }
  })
}

export function speakingHomeworkSummary(data) {
  const assigned = studentSpeakingAssignments(data)
  const pending = assigned.filter(task => !task.done)
  return { pending, total: assigned.length, completed: assigned.length - pending.length }
}

export function openSpeakingHomework(item, uid, navigate) {
  if (item.isRetake) sessionStorage.removeItem(`speaking-active-${uid}-${item.id}`)
  else if (item.attemptId) sessionStorage.setItem(`speaking-active-${uid}-${item.id}`, item.attemptId)
  navigate(item.path)
}
