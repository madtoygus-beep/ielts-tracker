const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const read = p => fs.readFileSync(p, 'utf8')
const hook = read('src/hooks/useEscapeDismiss.js')
const pages = ['ManageClasses','AdminDashboard','TeacherDashboard','StudentDashboard']

test('one Escape action at a time, ignored when already handled', () => {
  assert.match(hook, /event.key !== 'Escape' \|\| event.defaultPrevented/)
  assert.match(hook, /handlerRef.current\(\) === true/)
  assert.match(hook, /removeEventListener\('keydown', onKeyDown\)/)
})
test('four dashboard screens wire shared Escape with saving protections', () => {
  for (const name of pages) assert.match(read('src/pages/'+name+'.jsx'), /useEscapeDismiss\(\(\) => \{/)
  for (const name of ['ManageClasses','AdminDashboard','TeacherDashboard']) {
    const src = read('src/pages/'+name+'.jsx')
    assert.match(src, /if \(.*[Ss]aving.*\) return false/)
  }
})
test('managed class UI rejects archived and permanent-deletion accounts', () => {
  const src=read('src/pages/ManageClasses.jsx')
  assert.match(src, /userData.archived === true/)
  assert.match(src, /userData.permanentDeleteInProgress === true/)
})
test('Table Completion answers auto-resize when restored', () => {
  const src=read('src/pages/DoReading.jsx')
  assert.match(src, /function AutoGrowTableAnswer/)
  assert.match(src, /useLayoutEffect\(\(\) => \{/)
  assert.match(src, /\}, \[value\]\)/)
  assert.match(src, /<AutoGrowTableAnswer/)
  assert.match(src, /overflow-x-auto overscroll-x-contain/)
})
