'use strict'
// G3 SOURCE-ONLY release evidence. This does not query Cloud Run or prove a
// deployed revision's immutable digest; it MUST NOT be used as Production GO.
// No Firebase/GCP/Vercel clients or mutating commands are imported here.
const fs = require('node:fs')
const path = require('node:path')
const {createHash} = require('node:crypto')
const {execFileSync} = require('node:child_process')
const tracked = Object.freeze([
  'firebase.json', 'firestore.rules', 'functions/index.js',
  'functions/lib/aiWritingSponsoredEvaluation.js',
  'functions/lib/p0bG1AuthorityLease.js',
  'functions/lib/p0bManagedClassSecureWriter.js',
  'functions/lib/p0bCurrentAcademicAccess.js',
  'functions/package-lock.json', 'functions/package.json',
  'src/pages/TeacherDashboard.jsx',
  'src/services/p0bG4AcademicScoreGrouping.js',
  'package.json'
])
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function gitValue(root, args) {
  try { return execFileSync('git', args, {cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim() }
  catch { return null }
}
function draftProvenance(root, opts = {}) {
  const files = {}
  for (const name of tracked) {
    const absolute = path.join(root, name)
    if (!fs.existsSync(absolute)) throw new Error('Missing release evidence file: '+name)
    files[name] = digest(fs.readFileSync(absolute))
  }
  const engine = JSON.parse(fs.readFileSync(path.join(root,'functions/package.json'),'utf8')).engines?.node
  if (engine !== '22') throw new Error('Unexpected Functions Node engine: '+engine)
  const commit = opts.commit ?? gitValue(root,['rev-parse','HEAD'])
  const branch = opts.branch ?? gitValue(root,['branch','--show-current'])
  const gitChanges = opts.gitChanges ?? gitValue(root,['status','--porcelain'])
  return {
    schemaVersion:1,
    kind:'source-only-draft-not-deployment-proof',
    git:{commit:commit||null,branch:branch||null,clean:gitChanges === ''},
    node:{functionsEngine:engine,observedRuntime:process.version,
      runtimeMatchesFunctionsEngine:process.versions.node.split('.')[0] === engine},
    files,
    evidence:{sourceDigestSha256:digest(Buffer.from(JSON.stringify(files))),
      deployedFunctionRevision:null,deployedContainerImageDigest:null,
      vercelProductionDeploymentId:null,vercelProductionGitCommit:null,
      productionFirestoreRulesDigest:null},
    releaseStatus:'NO_GO',
    blockers:[
      'No immutable Cloud Run revision/image digest comparison has been performed',
      'No Vercel Production deployment-to-git-commit evidence',
      'No production Firestore Rules fingerprint check after authorized deployment',
      'No approved maintenance freeze, live-data migration or rollback rehearsal',
      'No Node 22 real Callable Emulator integration confirmation for this commit'
    ]
  }
}
if (require.main === module) {
  const root = path.resolve(process.argv[2] || process.cwd())
  process.stdout.write(JSON.stringify(draftProvenance(root),null,2)+'\n')
}
module.exports = {draftProvenance,tracked,digest}
