'use strict'
// Isolated E2E fixture. Never modifies functions/ or Firebase production files.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const { createHash } = require('node:crypto')
const PROJECT = 'demo-maxima-tracker'
const COMMIT = '40cadd1'
const FIXTURE = path.join(os.homedir(), 'Desktop', 'MAXIMA_P5B3D_FAKE_EMULATOR_40cadd1')
const ROOT = __dirname
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
function git(...args) {return cp.execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim()}
function fail(msg){console.error('REFUSED:',msg);process.exit(2)}
if (git('branch','--show-current') !== 'feature/2026-10-14-p5a-ai-writing' ||
    git('rev-parse','--short','HEAD') !== COMMIT) fail('Wrong branch/checkpoint. No files changed.')
// The new P5B3D tracked/untracked work may be present, but never accept other
// unstaged production modifications or a different function source.
const source = path.join(ROOT,'functions')
const original = path.join(source,'lib','openAiWritingProvider.js')
const fixtureMarker = 'MAXIMA_P5B3D_EMULATOR_ONLY_40cadd1'
const fakeProvider = String.raw`'use strict'
// LOCAL ONLY: The copied sandbox's fake provider has no fetch or HTTP transport.
// Do not add this stub to the real deployed functions/ directory.
const { normalizeAiWritingReport } = require('./aiWritingGrading')
const keyExpected = 'sk-p5b3d-fake-local-only-no-network'
const localHost = () => /^(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')
async function gradeWithOpenAi(prepared, apiKey) {
  if (!localHost() || process.env.GCLOUD_PROJECT !== 'demo-maxima-tracker' ||
      apiKey !== keyExpected) throw new Error('P5B3D: refused outside local demo emulator')
  const criterion = () => ({ band:6.5, explanation:'Local synthetic feedback only, not a real AI assessment.', evidence:'' })
  const task = () => ({ criteria: {
    taskAchievementOrResponse: criterion(), coherenceAndCohesion: criterion(),
    lexicalResource: criterion(), grammaticalRangeAndAccuracy: criterion()
  }, overview:'Emulator-only synthetic assessment.', strengths:[], priorities:[], corrections:[] })
  const raw = {task1:prepared.task1?task():null,task2:prepared.task2?task():null}
  return {report:normalizeAiWritingReport(raw,prepared), model:'p5b3d-local-fake-model',
    providerResponseId:'local-emulator-only'}
}
module.exports = { gradeWithOpenAi, PILOT_MODEL:'p5b3d-local-fake-model' }
`
// Correct escapes in the generated JavaScript regex are asserted below.
if (!fs.existsSync(original) || !fs.existsSync(path.join(source,'node_modules','firebase-admin')))
  fail('Functions dependencies are missing: run npm install in functions on the Mac.')
// Outside repository: never remove an unknown folder. Rebuild only one of ours.
if (fs.existsSync(FIXTURE)) {
  const marker = path.join(FIXTURE,'.p5b3d_emulator_only')
  if (!fs.existsSync(marker) || fs.readFileSync(marker,'utf8') !== fixtureMarker) fail('Existing fixture is not ours')
  fs.rmSync(FIXTURE,{recursive:true,force:true})
}
fs.mkdirSync(path.join(FIXTURE,'functions'),{recursive:true})
const filter = (src) => !src.split(path.sep).some(piece =>
  piece === 'node_modules' || piece === '.env' || piece.startsWith('.env.') ||
  piece.startsWith('.secret') || piece === '.firebase')
fs.cpSync(source,path.join(FIXTURE,'functions'),{recursive:true,filter})
fs.symlinkSync(path.join(source,'node_modules'),path.join(FIXTURE,'functions','node_modules'),'dir')
fs.writeFileSync(path.join(FIXTURE,'functions','lib','openAiWritingProvider.js'),fakeProvider)
fs.writeFileSync(path.join(FIXTURE,'functions','.secret.local'), 'MAXIMA_OPENAI_API_KEY=sk-p5b3d-fake-local-only-no-network\n')
fs.copyFileSync(path.join(ROOT,'firestore.rules'),path.join(FIXTURE,'firestore.rules'))
fs.writeFileSync(path.join(FIXTURE,'firebase.json'),JSON.stringify({
  firestore:{rules:'firestore.rules'},functions:{source:'functions'}
},null,2)+'\n')
fs.writeFileSync(path.join(FIXTURE,'.p5b3d_emulator_only'),fixtureMarker)
const fixtureProvider = path.join(FIXTURE,'functions','lib','openAiWritingProvider.js')
if (sha(fixtureProvider) === sha(original)) fail('Provider replacement was not applied.')
// The fake provider may only be in the sandbox. Check that deployed source still
// has the original transport, untouched.
if (!fs.readFileSync(original,'utf8').includes('https://api.openai.com/v1/responses')) fail('Original provider changed; refusing.')
console.log('P5B-3D LOCAL E2E FIXTURE READY:',FIXTURE)
console.log('Fake model and dummy secret ONLY in sandbox; original functions/ untouched.')
console.log('No real OpenAI transport in the sandbox provider, no Firebase deploy.')
