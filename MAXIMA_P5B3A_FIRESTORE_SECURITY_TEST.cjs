'use strict'
/*
 * P5B-3A: Browser access to teacher-managed institutional AI sponsorship
 * settings must remain DENIED, even to Admin. Server callable only.
 * IMPORTANT: Execute with --project demo-maxima-tracker Firestore emulator.
 */
const fs = require('node:fs')
const path = require('node:path')
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing')
const { doc, collection, getDoc, getDocs, query, where, setDoc, updateDoc, deleteDoc } = require('firebase/firestore')

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST ||
      (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== 'demo-maxima-tracker')) {
    throw new Error('SAFETY STOP: Local demo Firestore emulator required; never live Firestore.')
  }
  const rules = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8')
  const env = await initializeTestEnvironment({
    projectId: 'demo-maxima-tracker', firestore: { rules }
  })
  let pass=0, fail=0
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      const server=ctx.firestore()
      await setDoc(doc(server,'schools/maxima'),{status:'active'})
      await setDoc(doc(server,'schools/foreign'),{status:'active'})
      for(const [uid,role,schoolId] of [
        ['sponsored-student','student','maxima'],
        ['sponsored-teacher','teacher','maxima'],
        ['sponsored-admin','admin','maxima'],
        ['sponsored-outsider','teacher','foreign']
      ]) {
        await setDoc(doc(server,`users/${uid}`),{role,schoolId,status:'approved',deleted:false})
      }
      await setDoc(doc(server,'aiWritingSponsoredPolicies/writing_unit1'),{
        schemaVersion:1,schoolId:'maxima',contentType:'writing',contentId:'unit1',
        context:'homework',sourceCollection:'writingHomeworks',enabled:true,
        studentIds:['sponsored-student'],billing:'institution'
      })
    })
    const contexts=[
      ['student',env.authenticatedContext('sponsored-student').firestore()],
      ['teacher',env.authenticatedContext('sponsored-teacher').firestore()],
      ['admin',env.authenticatedContext('sponsored-admin').firestore()],
      ['foreign teacher',env.authenticatedContext('sponsored-outsider').firestore()],
      ['anonymous',env.unauthenticatedContext().firestore()]
    ]
    for(const [role,db] of contexts) {
      const target=doc(db,'aiWritingSponsoredPolicies/writing_unit1')
      const checks=[
        ['GET',()=>getDoc(target)],
        ['LIST',()=>getDocs(collection(db,'aiWritingSponsoredPolicies'))],
        ['QUERY',()=>getDocs(query(collection(db,'aiWritingSponsoredPolicies'),where('schoolId','==','maxima')))],
        ['CREATE',()=>setDoc(doc(db,'aiWritingSponsoredPolicies/writing_illegal'),{enabled:true})],
        ['UPDATE',()=>updateDoc(target,{studentIds:['sponsored-admin']})],
        ['DELETE',()=>deleteDoc(target)]
      ]
      for(const [action,operation] of checks) {
        try { await assertFails(operation());pass++;console.log(`PASS sponsored policy ${role} ${action} DENIED`) }
        catch(error) { fail++;console.error(`FAIL sponsored policy ${role} ${action}`,error?.message || error) }
      }
    }
    console.log(`\nP5B-3A Firestore Emulator: ${pass}/${pass+fail} PASS, ${fail} FAIL`)
    if(fail) process.exitCode=1
  } finally { await env.cleanup() }
}
main().catch(error=>{console.error(error?.stack || error);process.exitCode=1})
