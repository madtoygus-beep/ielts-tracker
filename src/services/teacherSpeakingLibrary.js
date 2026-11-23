import { loadTeacherSpeakingList } from './teacherSpeakingHomework.js'

// One instance belongs to one signed-in workspace. Never persist student data across accounts.
export function createTeacherSpeakingLibrary(api, accountId = '') {
  let state = {
    accountId, tasks: [], attempts: [], aiAvailable: false,
    tasksLoading: false, attemptsLoading: false,
    tasksLoaded: false, attemptsLoaded: false,
    tasksError: '', attemptsError: '', loading: false, error: ''
  }
  const listeners = new Set(), pending = new Map(), edits = new Map()
  let editVersion = 0
  const update = patch => {
    state = { ...state, ...patch }
    state.loading = state.tasksLoading || state.attemptsLoading
    state.error = [state.tasksError, state.attemptsError].filter(Boolean).join(' ')
    listeners.forEach(listener => listener())
  }
  const reconcile = (rows, startedAt) => {
    const result = new Map(rows.map(row => [row.id, row]))
    for (const [id, edit] of edits) if (edit.version > startedAt) result.set(id, edit.task)
    return [...result.values()]
  }
  const load = (kind, force = false) => {
    if (pending.has(kind)) return pending.get(kind)
    if (!force && (state[`${kind}Loaded`] || state[`${kind}Error`])) return Promise.resolve(state)
    const startedAt = editVersion
    update({ [`${kind}Loading`]: true, [`${kind}Error`]: '' })
    // Register before requesting, so concurrent consumers and Strict Mode reuse this promise.
    const request = Promise.resolve().then(() => loadTeacherSpeakingList(api, kind, {
      onPage: page => update({
        [kind]: kind === 'tasks' ? reconcile(page.rows, startedAt) : page.rows,
        aiAvailable: page.aiAvailable
      })
    })).then(() => update({ [`${kind}Loaded`]: true }))
      .catch(() => update({
        [`${kind}Error`]: `${kind === 'tasks' ? 'Speaking sets' : 'Student recordings'} could not be fully loaded. Refresh to retry.`
      }))
      .finally(() => {
        pending.delete(kind)
        update({ [`${kind}Loading`]: false })
      }).then(() => state)
    pending.set(kind, request)
    return request
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => state,
    ensure: () => Promise.all(['tasks', 'attempts'].map(kind => load(kind))),
    refresh: (kind = 'both') => Promise.all((kind === 'both' ? ['tasks', 'attempts'] : [kind]).map(value => load(value, true))),
    upsertTask(task) {
      if (!task?.id) return
      edits.set(task.id, { task, version: ++editVersion })
      update({ tasks: [...state.tasks.filter(row => row.id !== task.id), task] })
    }
  }
}
