import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
// Transform and render the actual presentation component without Firebase or model calls.
const require = createRequire(process.env.MAXIMA_TEST_PACKAGE || import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { transformWithOxc } = await import(require.resolve('vite'))
const filename = fileURLToPath(new URL('../src/components/WritingLengthNotice.jsx', import.meta.url))
const { code } = await transformWithOxc(readFileSync(filename, 'utf8').replace('export default function', 'module.exports.default = function'), filename, {
  jsx: { runtime: 'classic', pragma: 'React.createElement', pragmaFrag: 'React.Fragment' }
})
const mod = { exports: {} }
new Function('React', 'module', 'exports', code)(React, mod, mod.exports)
const Notice = mod.exports.default
const render = props => renderToStaticMarkup(React.createElement(Notice, props))
let passed = 0
for (const [taskNumber, wordCount, minimum] of [[1,57,150],[2,176,250],[1,149,150],[2,249,250],[1,0,150]]) {
  const props = Object.freeze({ taskNumber, wordCount })
  const output = render(props)
  assert.ok(output.includes(`${wordCount} / ${minimum} words`))
  assert.ok(output.includes('role="note"'))
  assert.ok(output.includes('Length alone does not determine a band'))
  passed++
}
for (const props of [{taskNumber:1,wordCount:150},{taskNumber:2,wordCount:250},{taskNumber:1,wordCount:200},{taskNumber:2,wordCount:-1},{taskNumber:1,wordCount:'57'},{taskNumber:3,wordCount:57},{taskNumber:1,wordCount:NaN}]) {
  assert.equal(render(props), '')
  passed++
}
console.log(`Writing length presentation: ${passed}/${passed} PASS; no API calls or score changes`)
