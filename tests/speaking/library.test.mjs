import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTeacherSpeakingLibrary } from '../../src/services/teacherSpeakingLibrary.js'
import { loadTeacherSpeakingList } from '../../src/services/teacherSpeakingHomework.js'
import { speakingLibraryRows, speakingRecordingRows } from '../../src/services/speakingLibraryPresentation.js'

const task = (n, extra = {}) => ({ id: `set-${String(n).padStart(3, '0')}`, title: `Speaking ${n}`, updatedAt: n,
  config: { questions: [{ part: 1, text: n === 88 ? 'Tell me about astronomy.' : 'Describe your home.' }] }, ...extra })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))

function pages(tasks, attempts = []) {
  const calls = []
  const api = async (op, data) => {
    calls.push({ op, ...data })
    assert.equal(op, 'list'); assert.equal(data.staff, true)
    assert.ok(['tasks', 'attempts'].includes(data.kind))
    const rows = data.kind === 'tasks' ? tasks : attempts
    const from = data.cursors[data.kind] ? rows.findIndex(row => row.id === data.cursors[data.kind]) + 1 : 0
    const page = rows.slice(from, from + 25)
    return { [data.kind]: page, cursors: { [data.kind]: from + 25 < rows.length ? page.at(-1).id : null }, aiAvailable: false }
  }
  return { api, calls }
}

test('all pages feed both the teacher library and search, including question text after the first 25 rows', async () => {
  const source = pages(Array.from({ length: 92 }, (_, n) => task(n, { archived: n >= 89 })))
  const store = createTeacherSpeakingLibrary(source.api, 'teacher-one')
  await store.ensure()
  const data = store.getSnapshot()
  assert.equal(data.accountId, 'teacher-one'); assert.equal(data.tasks.length, 92)
  assert.equal(data.tasksLoaded, true); assert.equal(data.tasksLoading, false)
  assert.deepEqual(speakingLibraryRows(data.tasks, { search: 'astronomy' }).map(row => row.id), ['set-088'])
  assert.deepEqual(speakingLibraryRows(data.tasks, { search: 'speaking 87' }).map(row => row.id), ['set-087'])
  assert.equal(speakingLibraryRows(data.tasks).length, 89)
  assert.equal(speakingLibraryRows(data.tasks, { status: 'archived' }).length, 3)
  assert.equal(speakingLibraryRows(data.tasks, { status: 'all' }).length, 92)
  assert.equal(source.calls.filter(call => call.kind === 'tasks').length, 4)
})

test('simultaneous consumers and returning to the library reuse the same in-flight and completed lists', async () => {
  const gate = deferred(), source = pages([task(1)])
  const store = createTeacherSpeakingLibrary(async (...args) => { await gate.promise; return source.api(...args) })
  const a = store.ensure(), b = store.ensure()
  gate.resolve(); await Promise.all([a, b])
  for (let n = 0; n < 8; n++) await store.ensure()
  assert.equal(source.calls.length, 2)
  await store.refresh('tasks')
  assert.equal(source.calls.length, 3)
  assert.equal(source.calls.filter(call => call.kind === 'attempts').length, 1)
})

test('slow or failing recordings never block the complete question library', async () => {
  const gate = deferred(), source = pages([task(1)])
  const store = createTeacherSpeakingLibrary(async (op, data) => {
    if (data.kind === 'attempts') { await gate.promise; throw Error('recordings offline') }
    return source.api(op, data)
  })
  const pending = store.ensure(); await tick()
  assert.equal(store.getSnapshot().tasksLoaded, true)
  assert.equal(store.getSnapshot().tasksLoading, false)
  assert.equal(store.getSnapshot().attemptsLoading, true)
  gate.resolve(); await pending
  assert.equal(store.getSnapshot().tasksError, '')
  assert.match(store.getSnapshot().attemptsError, /Student recordings/)
  assert.equal(store.getSnapshot().tasks.length, 1)
})

test('a failed later page stays incomplete and explicit refresh retries all pages', async () => {
  let offline = true
  const source = pages(Array.from({ length: 40 }, (_, n) => task(n)))
  const store = createTeacherSpeakingLibrary((op, data) => {
    if (data.cursors.tasks && offline) throw Error('offline')
    return source.api(op, data)
  })
  await store.ensure()
  assert.equal(store.getSnapshot().tasks.length, 25)
  assert.equal(store.getSnapshot().tasksLoaded, false)
  assert.match(store.getSnapshot().tasksError, /fully loaded/)
  offline = false; await store.refresh('tasks')
  assert.equal(store.getSnapshot().tasks.length, 40)
  assert.equal(store.getSnapshot().tasksLoaded, true)
  assert.equal(store.getSnapshot().tasksError, '')
})

test('pagination refuses loops, missing lists and duplicate records without hiding incomplete searches', async () => {
  await assert.rejects(loadTeacherSpeakingList(async () => ({ tasks: [task(1)], cursors: { tasks: 'same' } }), 'tasks'), /pagination/)
  await assert.rejects(loadTeacherSpeakingList(async () => ({ cursors: {} }), 'tasks'), /incomplete/)
  let count = 0
  const result = await loadTeacherSpeakingList(async () => ({ tasks: [task(1)], cursors: { tasks: count++ ? null : 'next' } }), 'tasks')
  assert.equal(result.rows.length, 1)
})

test('saving while a page is in flight cannot overwrite the newer task or drop a newly created set', async () => {
  const gate = deferred(), source = pages([task(1)])
  const store = createTeacherSpeakingLibrary(async (...args) => { await gate.promise; return source.api(...args) })
  const pending = store.ensure()
  store.upsertTask(task(1, { title: 'Saved title', assignedTo: ['student-one'], updatedAt: 99 }))
  store.upsertTask(task(2, { title: 'New set', updatedAt: 100 }))
  gate.resolve(); await pending
  assert.equal(store.getSnapshot().tasks.find(row => row.id === 'set-001').title, 'Saved title')
  assert.equal(store.getSnapshot().tasks.find(row => row.id === 'set-002').title, 'New set')
  await store.refresh('tasks')
  assert.equal(store.getSnapshot().tasks.length, 1, 'the next explicit refresh accepts the current authorized server list')
})

test('stores from different accounts share neither cached records nor pending requests', async () => {
  const one = createTeacherSpeakingLibrary(pages([task(1)]).api, 'one')
  const two = createTeacherSpeakingLibrary(pages([task(2)]).api, 'two')
  await one.ensure()
  assert.equal(two.getSnapshot().tasks.length, 0)
  await two.ensure()
  assert.equal(one.getSnapshot().tasks[0].id, 'set-001')
  assert.equal(two.getSnapshot().tasks[0].id, 'set-002')
})

test('part, session, archive and multi-word search filters combine over the entire library', () => {
  const rows = [task(1), task(2, { mode: 'mock', title: 'C12 advanced speaking', config: { questions: [{ part: 1 }, { part: 2 }, { part: 3 }] } }), task(3, { archived: true })]
  assert.deepEqual(speakingLibraryRows(rows, { search: 'ADVANCED c12', part: 'mixed', mode: 'mock' }).map(row => row.id), ['set-002'])
  assert.equal(speakingLibraryRows(rows, { part: 'part2' }).length, 0)
  assert.equal(speakingLibraryRows(rows, { mode: 'practice' }).length, 1)
  const recordings = Array.from({ length: 70 }, (_, n) => ({ id: String(n), title: 'C12 Speaking', studentName: `Learner ${n}`, startedAt: n }))
  assert.equal(speakingRecordingRows(recordings, 'learner 68 c12')[0].id, '68')
  assert.equal(speakingRecordingRows(recordings)[0].id, '69')
})
