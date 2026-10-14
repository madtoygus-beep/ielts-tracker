'use strict'
/*
  P5A-1: Every AI pilot setting, credit balance and adjustment audit document
  is server-only, even for Admin. Only the Cloud Functions Admin SDK can access.
  SAFETY: runs ONLY when FIRESTORE_EMULATOR_HOST exists; uses demo project.
*/
const fs = require('node:fs')
const path = require('node:path')
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing')
const { doc, collection, getDoc, getDocs, query, where, setDoc, updateDoc, deleteDoc } = require('firebase/firestore')

const COLLECTIONS = [
  { name: 'aiWritingSchoolSettings', id: 'maxima', data: { schoolId: 'maxima', pilotEnabled: false } },
  { name: 'aiWritingStudentAccess', id: 'p5a1-student', data: { schoolId: 'maxima', studentId: 'p5a1-student', enabled: true, creditsRemaining: 5 } },
  { name: 'aiWritingCreditOperations', id: 'p5a1-op-1', data: { schoolId: 'maxima', studentId: 'p5a1-student', creditDelta: 5 } }
]

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('SAFETY STOP: Firestore emulator is required. No production access allowed.')
  }
  const rules = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8')
  const env = await initializeTestEnvironment({
    projectId: 'demo-maxima-tracker', firestore: { rules }
  })
  let passed = 0
  let failed = 0
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      const adminDb = ctx.firestore()
      await setDoc(doc(adminDb, 'schools/maxima'), { status: 'active' })
      await setDoc(doc(adminDb, 'schools/other-school'), { status: 'active' })
      for (const [uid, role, schoolId] of [
        ['p5a1-student', 'student', 'maxima'],
        ['p5a1-teacher', 'teacher', 'maxima'],
        ['p5a1-admin', 'admin', 'maxima'],
        ['p5a1-foreign', 'student', 'other-school']
      ]) {
        await setDoc(doc(adminDb, `users/${uid}`), {
          schoolId, role, status: 'approved', deleted: false, teacherIds: []
        })
      }
      for (const item of COLLECTIONS) {
        await setDoc(doc(adminDb, `${item.name}/${item.id}`), item.data)
      }
    })

    const users = [
      ['student', env.authenticatedContext('p5a1-student').firestore()],
      ['teacher', env.authenticatedContext('p5a1-teacher').firestore()],
      ['admin', env.authenticatedContext('p5a1-admin').firestore()],
      ['foreign student', env.authenticatedContext('p5a1-foreign').firestore()],
      ['anonymous', env.unauthenticatedContext().firestore()]
    ]

    for (const item of COLLECTIONS) {
      for (const [role, clientDb] of users) {
        const target = doc(clientDb, item.name, item.id)
        const tests = [
          ['GET', () => getDoc(target)],
          ['LIST', () => getDocs(collection(clientDb, item.name))],
          ['QUERY', () => getDocs(query(collection(clientDb, item.name), where('schoolId', '==', 'maxima')))],
          ['CREATE', () => setDoc(doc(clientDb, item.name, 'p5a1-client-forbidden'), { schoolId:'maxima' })],
          ['UPDATE', () => updateDoc(target, { hacked: true })],
          ['DELETE', () => deleteDoc(target)]
        ]
        for (const [op, action] of tests) {
          try {
            await assertFails(action())
            passed++
            console.log(`PASS ${item.name} ${role} ${op} DENIED`)
          } catch (error) {
            failed++
            console.error(`FAIL ${item.name} ${role} ${op}`, error?.message || error)
          }
        }
      }
    }
    console.log(`\nP5A-1 Firestore Emulator: ${passed}/${passed + failed} PASS, ${failed} FAIL`)
    if (failed) process.exitCode = 1
  } finally {
    await env.cleanup()
  }
}

main().catch(error => {
  console.error('P5A-1 Emulator failed to initialize:', error?.stack || error)
  process.exitCode = 1
})
