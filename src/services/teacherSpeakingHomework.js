// Staff data comes from the authenticated Speaking callable, including authorization on every attempt.
export async function loadTeacherSpeakingHomework(api, staff = true) {
  const first = await api('list', { staff })
  const result = { tasks: [...first.tasks], attempts: [...first.attempts] }
  await Promise.all(['tasks', 'attempts'].map(async kind => {
    let cursor = first.cursors?.[kind]
    const seen = new Set()
    while (cursor) {
      if (seen.has(cursor)) throw Error('Speaking pagination could not be completed.')
      seen.add(cursor)
      const page = await api('list', { staff, kind, cursors: { [kind]: cursor } })
      result[kind].push(...page[kind])
      cursor = page.cursors?.[kind]
    }
  }))
  return result
}
export function teacherSpeakingHomeworkForStudent(data, studentId) {
  const latest = new Map()
  for (const attempt of data.attempts) {
    if (attempt.studentId !== studentId || attempt.mockId || !attempt.taskId) continue
    const old = latest.get(attempt.taskId)
    if (!old || Number(attempt.startedAt) > Number(old.startedAt) ||
        (attempt.startedAt === old.startedAt && attempt.id > old.id)) latest.set(attempt.taskId, attempt)
  }
  return [...new Map(data.tasks.filter(task => !task.archived && task.assignedTo?.includes(studentId)).map(task => [task.id, task])).values()]
    .map(task => ({ ...task, attempt: latest.get(task.id) || null }))
}
