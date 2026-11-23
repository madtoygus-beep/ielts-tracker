import { loadTeacherSpeakingList } from './teacherSpeakingHomework.js'
import { speakingHomeworkSummary } from './speakingHomework.js'

export function createStudentSpeakingLibrary(api, { accountId = '', now = Date.now, isCurrent = () => true, maxAge = 60000 } = {}) {
  let state = { accountId, tasks: [], attempts: [], tasksLoaded: false, attemptsLoaded: false,
    tasksLoading: false, attemptsLoading: false, loading: false, error: '', tasksError: '', attemptsError: '', aiAvailable: false,
    pending: [], total: 0, completed: 0, view: { assignmentSearch: '', part: 'all', tab: 'tasks', reportSearch: '' } }
  let pending = null, checkedAt = -Infinity, triedAt = -Infinity, version = 0, watchers = 0, stopWatching
  const listeners = new Set(), taskEdits = new Map(), attemptEdits = new Map(), reports = new Map(), reads = new Map(), reportVersions = new Map()
  const assertCurrent = () => { if (!isCurrent()) throw Error('Your account changed. Reopen Speaking from your dashboard.') }
  const update = patch => {
    if (!isCurrent()) return
    state = { ...state, ...patch }
    state.loading = state.tasksLoading || state.attemptsLoading
    state.error = [state.tasksError, state.attemptsError].filter(Boolean).join(' ')
    Object.assign(state, speakingHomeworkSummary(state))
    listeners.forEach(listener => listener())
  }
  const invoke = async (op, data) => { assertCurrent(); const value = await api(op, data); assertCurrent(); return value }
  const merge = (rows, edits, started, existingOnly = false) => {
    const result = new Map(rows.map(row => [row.id, row]))
    for (const [id, edit] of edits) if (edit.version > started && (!existingOnly || result.has(id))) result.set(id, { ...result.get(id), ...edit.value })
    return [...result.values()]
  }
  const refresh = (force = true) => {
    if (!isCurrent()) return Promise.resolve(state)
    if (pending) return pending
    if (!force && (now() - checkedAt < maxAge || state.error && now() - triedAt < maxAge)) return Promise.resolve(state)
    triedAt = now()
    const started = version
    update({ tasksLoading: true, attemptsLoading: true, tasksError: '', attemptsError: '' })
    pending = Promise.all(['tasks', 'attempts'].map(async kind => {
      try {
        const result = await loadTeacherSpeakingList(invoke, kind, { staff: false })
        update({ [kind]: merge(result.rows, kind === 'tasks' ? taskEdits : attemptEdits, started, kind === 'tasks'), [`${kind}Loaded`]: true, aiAvailable: result.aiAvailable })
      } catch (problem) {
        update({ [`${kind}Error`]: problem.message || `Speaking ${kind} could not be loaded. Refresh to retry.` })
      } finally { update({ [`${kind}Loading`]: false }) }
    })).then(() => {
      if (!state.error) checkedAt = now()
      return state
    }).finally(() => { pending = null })
    return pending
  }
  const rememberAttempt = (attempt, head = false) => {
    if (!attempt?.id || !attempt.status) return
    const previous = state.attempts.find(row => row.id === attempt.id)
    const value = { ...previous, ...attempt }
    attemptEdits.set(value.id, { value, version: ++version })
    const patch = { attempts: [...state.attempts.filter(row => row.id !== value.id), value] }
    if (head && value.taskId && !value.mockId) {
      const task = state.tasks.find(row => row.id === value.taskId)
      const updated = { id: value.taskId, ...task, latestAttemptId: value.id, latestAttemptStatus: value.status, retakeAvailable: false }
      taskEdits.set(value.taskId, { value: updated, version })
      if (task) {
        patch.tasks = state.tasks.map(row => row.id === task.id ? updated : row)
      }
    }
    update(patch)
  }
  const invalidateReport = id => {
    if (!id) return
    reports.delete(id); reads.delete(id); reportVersions.set(id, (reportVersions.get(id) || 0) + 1)
  }
  const studentApi = async (op, data = {}) => {
    if (op === 'get' && data.staff !== true) {
      assertCurrent()
      const { forceRefresh, ...request } = data, id = request.attemptId
      const saved = reports.get(id)
      if (!forceRefresh && saved && now() - saved.at < 30000) return saved.value
      if (reads.has(id)) return reads.get(id)
      const started = reportVersions.get(id) || 0
      const read = invoke(op, request).then(value => {
        if ((reportVersions.get(id) || 0) === started) {
          rememberAttempt(value)
          // Active question timers and in-progress AI assessments always use a fresh server response.
          if (value.status !== 'recording' && value.aiStatus !== 'processing') reports.set(id, { at: now(), value })
        }
        return value
      }).finally(() => { if (reads.get(id) === read) reads.delete(id) })
      reads.set(id, read)
      return read
    }
    if (['start', 'saveAnswer', 'submit', 'evaluate'].includes(op)) invalidateReport(data.attemptId)
    try {
      const value = await invoke(op, data)
      if (['start', 'saveAnswer', 'submit'].includes(op)) { invalidateReport(value.id); rememberAttempt(value, true) }
      if (op === 'evaluate') { invalidateReport(data.attemptId); checkedAt = -Infinity }
      return value
    } catch (problem) {
      if (/permission|assignment|teacher restarted|newer Speaking attempt/i.test(`${problem.code || ''} ${problem.message || ''}`)) checkedAt = -Infinity
      throw problem
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    ensure: () => refresh(false), refresh: () => refresh(true), api: studentApi,
    setView: patch => update({ view: { ...state.view, ...patch } }),
    watch(environment) {
      watchers++
      if (watchers === 1) {
        const visible = () => environment.document.visibilityState !== 'hidden'
        const revalidate = () => { if (visible()) void refresh(false) }
        environment.addEventListener('focus', revalidate)
        environment.document.addEventListener('visibilitychange', revalidate)
        const timer = environment.setInterval(revalidate, maxAge)
        stopWatching = () => { environment.clearInterval(timer); environment.removeEventListener('focus', revalidate); environment.document.removeEventListener('visibilitychange', revalidate) }
        revalidate()
      }
      return () => { if (--watchers === 0) { stopWatching?.(); stopWatching = null } }
    }
  }
}
