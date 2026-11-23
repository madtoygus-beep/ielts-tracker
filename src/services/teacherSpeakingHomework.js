// Keep library reads authenticated. Question pages must not wait for recording authorization.
export async function loadTeacherSpeakingList(api, kind, { staff = true, onPage } = {}) {
  if (!['tasks', 'attempts'].includes(kind)) throw Error('Invalid Speaking list.')
  const rows = new Map(), seen = new Set()
  let cursor = null, aiAvailable
  do {
    const page = await api('list', { staff, kind, cursors: cursor ? { [kind]: cursor } : {} })
    if (!Array.isArray(page[kind])) throw Error('Speaking returned an incomplete list.')
    for (const row of page[kind]) rows.set(row.id, row)
    aiAvailable = page.aiAvailable === true
    cursor = page.cursors?.[kind] || null
    if (cursor && seen.has(cursor)) throw Error('Speaking pagination could not be completed.')
    if (cursor) seen.add(cursor)
    onPage?.({ rows: [...rows.values()], aiAvailable })
  } while (cursor)
  return { rows: [...rows.values()], aiAvailable }
}
export async function loadTeacherSpeakingHomework(api, staff = true) {
  const [tasks, attempts] = await Promise.all([
    loadTeacherSpeakingList(api, 'tasks', { staff }),
    loadTeacherSpeakingList(api, 'attempts', { staff })
  ])
  return { tasks: tasks.rows, attempts: attempts.rows }
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
