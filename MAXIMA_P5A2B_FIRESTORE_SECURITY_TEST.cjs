'use strict'
/*
 * P5A-2B: New AI evaluation and monthly usage data must be SERVER-ONLY.
 * Safe only on Firestore Emulator with demo project; never against live data.
 */
const fs = require('node:fs')
const path = require('node:path')
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing')
const { doc, collection, getDoc, getDocs, query, where, setDoc, updateDoc, deleteDoc } = require('firebase/firestore')

const COLLECTIONS = [
  { collection: 'aiWritingEvaluations', id: 'p5a2b-report',
    data: { schoolId: 'maxima', studentId: 'p5a2b-student', uid: 'p5a2b-student', context: 'mock', status: 'completed' } },
  { collection: 'aiWritingMonthlyUsage', id: 'maxima_202610',
    data: { schoolId: 'maxima', month: '202610', requestCount: 1, completedCount: 1 } }
]

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== 'demo-maxima-tracker') {
    throw new Error('SAFETY STOP: Run against local demo Firestore emulator ONLY.')
  }
  const rules = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8')
  const env = await initializeTestEnvironment({
    projectId: 'demo-maxima-tracker', firestore: { rules }
  })
  let pass = 0; let fail = 0
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      const server = ctx.firestore()
      await setDoc(doc(server, 'schools/maxima'), { status: 'active' })
      await setDoc(doc(server, 'schools/other-school'), { status: 'active' })
      for (const [uid, role, schoolId] of [
        ['p5a2b-student', 'student', 'maxima'],
        ['p5a2b-teacher', 'teacher', 'maxima'],
        ['p5a2b-admin', 'admin', 'maxima'],
        ['p5a2b-foreign', 'student', 'other-school']
      ]) {
        await setDoc(doc(server, `users/${uid}`), {
          role, schoolId, status: 'approved', deleted: false
        })
      }
      for (const item of COLLECTIONS) {
        await setDoc(doc(server, item.collection, item.id), item.data)
      }
    })
    const users = [
      ['student', env.authenticatedContext('p5a2b-student').firestore()],
      ['teacher', env.authenticatedContext('p5a2b-teacher').firestore()],
      ['admin', env.authenticatedContext('p5a2b-admin').firestore()],
      ['foreign student', env.authenticatedContext('p5a2b-foreign').firestore()],
      ['anonymous', env.unauthenticatedContext().firestore()]
    ]
    for (const item of COLLECTIONS) {
      for (const [role, db] of users) {
        const target = doc(db, item.collection, item.id)
        const checks = [
          ['GET', () => getDoc(target)],
          ['LIST', () => getDocs(collection(db, item.collection))],
          ['QUERY', () => getDocs(query(collection(db, item.collection), where('schoolId', '==', 'maxima')))],
          ['CREATE', () => setDoc(doc(db, item.collection, 'p5a2b-forbidden'), { schoolId:'maxima' })],
          ['UPDATE', () => updateDoc(target, { status: 'hacked' })],
          ['DELETE', () => deleteDoc(target)]
        ]
        for (const [actionName, action] of checks) {
          try {
            await assertFails(action())
            pass++
            console.log(`PASS ${item.collection} ${role} ${actionName} DENIED`)
          } catch (error) {
            fail++
            console.error(`FAIL ${item.collection} ${role} ${actionName}:`, error?.message || error)
          }
        }
      }
    }
    console.log(`\nP5A-2B Firestore Emulator: ${pass}/${pass + fail} PASS, ${fail} FAIL`)
    if (fail) process.exitCode = 1
  } finally { await env.cleanup() }
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1 })
