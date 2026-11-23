import { speakingPracticeKind } from './speakingPolicy.js'

export function speakingLibraryRows(tasks, { search = '', status = 'active', part = 'all', mode = 'all' } = {}) {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return tasks.filter(task => {
    if (status !== 'all' && Boolean(task.archived) !== (status === 'archived')) return false
    if (part !== 'all' && speakingPracticeKind(task.config) !== part) return false
    if (mode !== 'all' && (task.mode || 'practice') !== mode) return false
    const text = [task.title, task.teacherName, task.mode === 'mock' ? 'Full Speaking Mock' : 'Speaking practice',
      ...(task.config?.questions || []).map(question => `Part ${question.part} ${question.text}`)].join(' ').toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  }).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0) ||
    (a.title || '').localeCompare(b.title || '', 'en', { numeric: true }) || a.id.localeCompare(b.id))
}

export function speakingRecordingRows(attempts, search = '') {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return attempts.filter(attempt => {
    const text = [attempt.title, attempt.studentName, attempt.teacherName, attempt.status, attempt.aiStatus].join(' ').toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  }).sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0) || a.id.localeCompare(b.id))
}
