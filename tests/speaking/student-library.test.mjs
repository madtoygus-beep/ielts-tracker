import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStudentSpeakingLibrary } from '../../src/services/studentSpeakingLibrary.js'
import { studentSpeakingAssignments } from '../../src/services/speakingHomework.js'

const task = (id, extra = {}) => ({ id, title: id, latestAttemptId: '', latestAttemptStatus: '', config: { questions: [{ part: 1, text: 'Your home' }] }, ...extra })
const attempt = (extra = {}) => ({ id: 'a1', taskId: 'one', title: 'Home', status: 'submitted', startedAt: 1, aiStatus: 'not_requested', questions: [], ...extra })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(tasks = [task('one')], attempts = []) {
  const calls = []
  const api = async (op, data = {}) => {
    calls.push({ op, ...data })
    if (op === 'list') {
      assert.equal(data.staff, false)
      assert.ok(['tasks', 'attempts'].includes(data.kind))
      const rows = data.kind === 'tasks' ? tasks : attempts
      const from = data.cursors?.[data.kind] ? rows.findIndex(row => row.id === data.cursors[data.kind]) + 1 : 0
      const page = rows.slice(from, from + 25)
      return { [data.kind]: page, cursors: { [data.kind]: from + 25 < rows.length ? page.at(-1).id : null }, aiAvailable: false }
    }
    return attempt({ status: op === 'start' ? 'recording' : 'submitted' })
  }
  return { api, calls }
}
function environment() {
  const events = new Map(), visibleEvents = new Map(), timers = new Set()
  return {
    events, visibleEvents, timers,
    document: { visibilityState: 'visible', addEventListener: (name, fn) => visibleEvents.set(name, fn), removeEventListener: name => visibleEvents.delete(name) },
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    setInterval: fn => { timers.add(fn); return fn }, clearInterval: fn => timers.delete(fn)
  }
}

test('dashboard, homework and analytics share all pages; fresh remounts and repeated focus do not refetch', async () => {
  const source = fixture(Array.from({ length: 80 }, (_, i) => task(`task-${i}`)))
  let time = 0
  const library = createStudentSpeakingLibrary(source.api, { now: () => time }), env = environment()
  const stopOne = library.watch(env), stopTwo = library.watch(env)
  await library.ensure()
  assert.equal(library.getSnapshot().tasks.length, 80)
  assert.equal(source.calls.length, 5)
  assert.equal(env.timers.size, 1); assert.equal(env.events.size, 1); assert.equal(env.visibleEvents.size, 1)
  env.events.get('focus')(); env.visibleEvents.get('visibilitychange')(); await library.ensure()
  assert.equal(source.calls.length, 5)
  stopOne(); assert.equal(env.timers.size, 1); stopTwo(); assert.equal(env.timers.size, 0)
  const stopThree = library.watch(env); await library.ensure(); assert.equal(source.calls.length, 5)
  time = 60001; env.events.get('focus')(); env.visibleEvents.get('visibilitychange')(); await library.ensure()
  assert.equal(source.calls.length, 10)
  assert.ok(source.calls.every(call => call.op === 'list'), 'no exam or paid AI operation starts during reading or refresh')
  stopThree(); assert.equal(env.events.size, 0); assert.equal(env.visibleEvents.size, 0)
})

test('hidden tabs do not poll; returning after expiry revalidates once', async () => {
  const source = fixture(), env = environment(); let time = 0
  const library = createStudentSpeakingLibrary(source.api, { now: () => time })
  const stop = library.watch(env); await library.ensure()
  env.document.visibilityState = 'hidden'; time = 70000
  for (const timer of env.timers) timer()
  assert.equal(source.calls.length, 2)
  env.document.visibilityState = 'visible'; env.visibleEvents.get('visibilitychange')(); await library.ensure()
  assert.equal(source.calls.length, 4); stop()
})

test('completed reports reuse and deduplicate short-lived reads; explicit refresh and TTL always reach the server', async () => {
  const source = fixture(); let time = 0
  const library = createStudentSpeakingLibrary(source.api, { now: () => time })
  await Promise.all([library.api('get', { attemptId: 'a1' }), library.api('get', { attemptId: 'a1' })])
  await library.api('get', { attemptId: 'a1' })
  assert.equal(source.calls.length, 1)
  await library.api('get', { attemptId: 'a1', forceRefresh: true })
  assert.equal(source.calls.length, 2); assert.equal(source.calls[1].forceRefresh, undefined)
  time = 30001; await library.api('get', { attemptId: 'a1' }); assert.equal(source.calls.length, 3)
})

test('recording timers and processing AI reports are never served from the completed-report cache', async () => {
  for (const value of [attempt({ status: 'recording' }), attempt({ aiStatus: 'processing' })]) {
    let reads = 0
    const library = createStudentSpeakingLibrary(async () => { reads++; return value })
    await library.api('get', { attemptId: value.id }); await library.api('get', { attemptId: value.id })
    assert.equal(reads, 2)
  }
})

test('start and submit remain server-authorized writes and immediately update homework without reloading lists', async () => {
  const source = fixture(), library = createStudentSpeakingLibrary(source.api)
  await library.ensure(); await library.api('start', { taskId: 'one' })
  assert.equal(library.getSnapshot().pending[0].attemptId, 'a1')
  await library.api('submit', { attemptId: 'a1' })
  assert.equal(library.getSnapshot().completed, 1); assert.equal(library.getSnapshot().pending.length, 0)
  await library.api('start', { taskId: 'one' }); await library.api('submit', { attemptId: 'a1' })
  assert.equal(source.calls.filter(call => call.op === 'start').length, 2)
  assert.equal(source.calls.filter(call => call.op === 'submit').length, 2)
  assert.equal(source.calls.filter(call => call.op === 'list').length, 2)
})

test('a teacher reset or canonical empty head cannot be overridden by an older completed cached attempt', () => {
  const attempts = [attempt()]
  const rows = studentSpeakingAssignments({ tasks: [task('one'), task('two', { latestAttemptId: 'fresh', latestAttemptStatus: 'recording' })], attempts })
  assert.equal(rows[0].done, false); assert.equal(rows[0].reportId, '')
  assert.equal(rows[1].done, false); assert.equal(rows[1].attemptId, 'fresh')
  const done = studentSpeakingAssignments({ tasks: [task('one', { latestAttemptId: 'a1', latestAttemptStatus: 'submitted' })], attempts: [] })
  assert.equal(done[0].done, true, 'the authoritative task head works before history finishes loading')
})

test('progress arriving during an initial list request survives the older list snapshot', async () => {
  const gate = deferred(), source = fixture(), library = createStudentSpeakingLibrary(async (op, data) => {
    if (op === 'list') await gate.promise
    return source.api(op, data)
  })
  const reading = library.ensure()
  await library.api('submit', { attemptId: 'a1' })
  gate.resolve(); await reading
  assert.equal(library.getSnapshot().completed, 1)
  assert.equal(library.getSnapshot().tasks[0].latestAttemptId, 'a1')
})

test('reading an earlier report does not move the current attempt or reopen submitted homework', async () => {
  const source = fixture([task('one', { latestAttemptId: 'new', latestAttemptStatus: 'submitted' })])
  const library = createStudentSpeakingLibrary(source.api)
  await library.ensure(); await library.api('get', { attemptId: 'a1' })
  assert.equal(library.getSnapshot().tasks[0].latestAttemptId, 'new')
  assert.equal(library.getSnapshot().completed, 1)
})

test('failed refresh keeps loaded homework, avoids a focus retry storm, and permits explicit retry', async () => {
  const source = fixture(); let offline = false, time = 0
  const library = createStudentSpeakingLibrary((...args) => { if (offline) throw Error('offline'); return source.api(...args) }, { now: () => time })
  await library.ensure(); offline = true; time = 60001
  await library.ensure(); assert.equal(library.getSnapshot().tasks.length, 1)
  assert.equal(library.getSnapshot().tasksError, 'offline')
  offline = false; await library.ensure(); assert.equal(source.calls.length, 2)
  await library.refresh(); assert.equal(source.calls.length, 4); assert.equal(library.getSnapshot().error, '')
})

test('sign-out prevents cached reads and ignores an old account response, while another account starts empty', async () => {
  const gate = deferred(), source = fixture(); let current = true
  const old = createStudentSpeakingLibrary(async (...args) => { await gate.promise; return source.api(...args) }, { accountId: 'old', isCurrent: () => current })
  const reading = old.ensure(); current = false; gate.resolve(); await reading
  assert.equal(old.getSnapshot().tasks.length, 0)
  await assert.rejects(old.api('get', { attemptId: 'a1' }), /account changed/)
  const next = createStudentSpeakingLibrary(source.api, { accountId: 'next' })
  assert.equal(next.getSnapshot().tasks.length, 0); assert.equal(next.getSnapshot().accountId, 'next')
})
