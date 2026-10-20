'use strict'
// P0-A recovery transaction integration. Requires ONLY the local demo Firestore Emulator.
// Never run with production Firebase credentials, live project IDs, or remote Firestore.
const test = require('node:test')
const assert = require('node:assert/strict')
const {createHash} = require('node:crypto')
// firebase-admin belongs to the functions package, not the React root.
const {createRequire} = require('node:module')
const {join} = require('node:path')
const requireFunctions = createRequire(join(__dirname, '../functions/package.json'))
const {initializeApp,deleteApp} = requireFunctions('firebase-admin/app')
const {getFirestore,FieldValue} = requireFunctions('firebase-admin/firestore')
const {createAiWritingSponsoredRecoveryService}=require('../functions/lib/aiWritingSponsoredRecovery')
const HOST=process.env.FIRESTORE_EMULATOR_HOST || ''
const PROJECT=process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || ''
assert.match(HOST,/^(127\.0\.0\.1|localhost):8081$/,
  'STOP: This test requires a loopback Firestore Emulator on port 8081.')
assert.equal(PROJECT,'demo-maxima-p0a',
  'STOP: Use --project demo-maxima-p0a; production is forbidden.')
const NOW=Date.parse('2026-11-02T00:00:00Z')
const app=initializeApp({projectId:PROJECT},'maxima-p0a-recovery-emulator')
const db=getFirestore(app)
const svc=createAiWritingSponsoredRecoveryService({db,FieldValue,now:()=>NOW})
const monthPath='aiWritingMonthlyUsage/maxima_202610'
const jobId=createHash('sha256').update('p0a-local-recovery-test').digest('hex')
const jobPath=`aiWritingEvaluations/${jobId}`
async function seed(job={},month={}) {
 await Promise.all([
   db.doc(jobPath).set({jobId,studentId:'student001',schoolId:'maxima',billing:'institution',
     billingMode:'sponsored_auto',context:'homework',status:'processing',month:'202610',
     leaseId:'test',leaseUntilMs:NOW-1000,...job}),
   db.doc(monthPath).set({schoolId:'maxima',month:'202610',requestCount:10,
     pendingCount:1,completedCount:6,sponsoredRequestCount:5,...month})
 ])
}
test('Firestore transaction: parallel repair is idempotent, preserves requestCount and original month', async()=>{
 await seed()
 const calls=await Promise.all(Array.from({length:8},()=>svc.reconcileJob({jobId,expectedStudentId:'student001'})))
 assert.equal(calls.filter(r=>r.status==='reconciled').length,1)
 assert.ok(calls.every(r=>['reconciled','failed'].includes(r.status)))
 const [job,month]=await Promise.all([db.doc(jobPath).get(),db.doc(monthPath).get()])
 assert.equal(job.data().status,'failed')
 assert.equal(month.data().pendingCount,0)
 assert.equal(month.data().requestCount,10)
 assert.equal(month.data().sponsoredRequestCount,5)
 assert.equal((await db.doc('aiWritingMonthlyUsage/maxima_202611').get()).exists,false)
 await seed({leaseUntilMs:NOW+100000})
 assert.equal((await svc.reconcileJob({jobId})).status,'active')
 assert.equal((await db.doc(monthPath).get()).data().pendingCount,1)
 await seed({}, {pendingCount:'broken'})
 assert.equal((await svc.reconcileJob({jobId})).status,'needs_review')
 assert.equal((await db.doc(jobPath).get()).data().status,'processing')
})
test.after(async()=>{
 await Promise.all([db.doc(jobPath).delete(),db.doc(monthPath).delete()])
 await deleteApp(app)
})
