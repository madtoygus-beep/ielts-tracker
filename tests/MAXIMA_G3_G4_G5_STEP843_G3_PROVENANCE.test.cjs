'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const {draftProvenance,tracked,digest}=require('../tools/p0bG3SourceProvenance.cjs')

test('G3 produces SHA256 hashes of complete security and release source set',()=>{
  const p=draftProvenance(process.cwd(),{commit:'f9d182a',branch:'security/p0b2b-g1g2-step787-20261022',gitChanges:''})
  assert.equal(p.git.clean,true)
  assert.equal(p.node.functionsEngine,'22')
  assert.equal(Object.keys(p.files).length,tracked.length)
  for(const file of tracked)assert.equal(p.files[file],digest(fs.readFileSync(file)))
})
test('G3 a local source hash is NOT mistaken for deployed image/revision evidence',()=>{
  const p=draftProvenance(process.cwd(),{commit:'f9d182a',branch:'security/p0b2b-g1g2-step787-20261022',gitChanges:''})
  assert.equal(p.releaseStatus,'NO_GO')
  assert.equal(p.kind,'source-only-draft-not-deployment-proof')
  assert.equal(p.evidence.deployedContainerImageDigest,null)
  assert.equal(p.evidence.deployedFunctionRevision,null)
  assert.equal(p.evidence.vercelProductionGitCommit,null)
  assert.equal(p.evidence.productionFirestoreRulesDigest,null)
  assert.equal(p.blockers.length,5)
})
test('G3 unexpected runtime or dirty worktree does not create false clean proof',()=>{
  const p=draftProvenance(process.cwd(),{commit:'f9d182a',branch:'security/p0b2b-g1g2-step787-20261022',gitChanges:' M functions/index.js'})
  assert.equal(p.git.clean,false)
  assert.equal(p.node.runtimeMatchesFunctionsEngine,process.versions.node.split('.')[0]==='22')
  assert.equal(p.releaseStatus,'NO_GO')
})
test('G3 local provenance collector does not deploy or alter a live project',()=>{
  const source=fs.readFileSync('tools/p0bG3SourceProvenance.cjs','utf8')
  assert.doesNotMatch(source, /execFileSync\(['"](?:gcloud|firebase|vercel|npm)['"]/)
  assert.doesNotMatch(source, /https?\.request|fetch\(|firebase-admin|runTransaction|\.bulkWriter\(|\.doc\(/)
})
