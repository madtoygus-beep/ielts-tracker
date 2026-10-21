'use strict'
// P0-B2B Step 701: teacher self-admission protection, no Firebase or provider calls.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { mutateManagedClassWithIndex } = require('../functions/lib/p0bAcademicMembershipIndex')

const SCHOOL = 'maxima', TEACHER = 't701'
const INDEX = `schools/${SCHOOL}/teacherAcademicIndex/${TEACHER}`
const FieldValue = { arrayUnion: (...items) => ({ unionItems: items }) }
const classroom = (studentIds, extra={}) => ({
  name: 'IELTS Grade 11', teacherId: TEACHER, schoolId: SCHOOL,
  archived: false, studentIds, ...extra
})
const ref = path => ({ id: path.split('/').at(-1), path })
function dbFixture(initial={}) {
  const documents = new Map(Object.entries(initial).map(([path,value])=>[path,structuredClone(value)]))
  const db = {
    doc: ref,
    collection: collection => ({ where(field, op, value) {
      assert.equal(collection, 'classes')
      assert.equal(field, 'teacherId')
      assert.equal(op, '==')
      return { collection, field, value }
    } }),
    async runTransaction(callback) {
      const updates = []
      const tx = {
        async get(key) {
          if (key.path) return {
            id:key.id, exists:documents.has(key.path),
            data:()=>structuredClone(documents.get(key.path))
          }
          return {docs:[...documents.entries()]
            .filter(([path,data])=>path.startsWith(`${key.collection}/`) && data[key.field]===key.value)
            .map(([path,data])=>({id:path.split('/').at(-1),exists:true,data:()=>structuredClone(data)}))}
        },
        set(key, value, opt={}) {updates.push(['set',key.path,structuredClone(value),opt])},
        delete(key){updates.push(['delete',key.path])}
      }
      const result=await callback(tx)
      for(const [op,path,value,opt] of updates){
        if(op==='delete') {documents.delete(path);continue}
        const previous=documents.get(path) || {}
        const next=opt.merge?{...previous,...value}:value
        for(const [name,val] of Object.entries(next)) {
          if(val?.unionItems) next[name]=[...new Set([...(previous[name]||[]),...val.unionItems])]
        }
        documents.set(path,structuredClone(next))
      }
      return result
    }
  }
  const write = (classId, operation, payload, actorRole='teacher', actor=TEACHER) =>
    mutateManagedClassWithIndex({
      db, FieldValue, classRef:ref(`classes/${classId}`), teacherId:TEACHER,
      schoolId:SCHOOL, operation, payload,
      studentRefs:operation==='save'?(payload.studentIds||[]).map(uid=>ref(`users/${uid}`)):[],
      actorRole,updatedBy:actor,now:'2026-10-21T00:00:00Z'
    })
  return {documents,write}
}

test('teacher cannot self-admit an unapproved school learner; no writes survive rejection', async()=>{
  const {documents,write}=dbFixture({'users/new701':{role:'student',teacherIds:[TEACHER]}})
  const before=structuredClone([...documents])
  await assert.rejects(write('A','save',classroom(['new701'])),/admin authorization/)
  assert.deepEqual([...documents],before)
})

test('teacher can create an empty class and edit its metadata without gaining access',async()=>{
  const {documents,write}=dbFixture()
  await write('A','save',classroom([]))
  await write('A','save',classroom([],{name:'Updated name'}))
  assert.deepEqual(documents.get(INDEX).activeStudentIds,[])
  assert.equal(documents.get('classes/A').name,'Updated name')
})

test('admin explicitly admits student, teacher can edit and organize that student',async()=>{
  const {documents,write}=dbFixture()
  await write('A','save',classroom(['u1']),'admin','schoolAdmin')
  await write('B','save',classroom(['u1']),'teacher',TEACHER)
  assert.deepEqual(documents.get(INDEX).activeStudentIds,['u1'])
  await write('A','save',classroom([]),'teacher',TEACHER)
  assert.deepEqual(documents.get(INDEX).activeStudentIds,['u1'])
})

test('teacher cannot add a second student after an admin admitted the first',async()=>{
  const {documents,write}=dbFixture()
  await write('A','save',classroom(['u1']),'admin','schoolAdmin')
  const before=structuredClone([...documents])
  await assert.rejects(write('A','save',classroom(['u1','u2'])),/admin authorization/)
  assert.deepEqual([...documents],before)
})

test('teacher removal revokes index and teacher cannot restore without renewed admission',async()=>{
  const {documents,write}=dbFixture()
  await write('A','save',classroom(['u1']),'admin','schoolAdmin')
  await write('A','save',classroom([]))
  assert.deepEqual(documents.get(INDEX).activeStudentIds,[])
  await assert.rejects(write('A','save',classroom(['u1'])),/admin authorization/)
  assert.deepEqual(documents.get(INDEX).activeStudentIds,[])
})

test('teacher can archive a class but cannot unarchive to self-restore student permission',async()=>{
  const {documents,write}=dbFixture()
  await write('A','save',classroom(['u1']),'admin','schoolAdmin')
  await write('A','archive',{archived:true})
  assert.deepEqual(documents.get(INDEX).activeStudentIds,[])
  await assert.rejects(write('A','archive',{archived:false}),/admin authorization/)
  assert.deepEqual(documents.get(INDEX).activeStudentIds,[])
  await write('A','archive',{archived:false},'admin','schoolAdmin')
  assert.deepEqual(documents.get(INDEX).activeStudentIds,['u1'])
})

test('missing or forged mutation role is rejected before writes',async()=>{
  const {documents,write}=dbFixture()
  const initial=structuredClone([...documents])
  await assert.rejects(write('A','save',classroom(['u1']),null),/Invalid P0-B2A class index update request/)
  await assert.rejects(write('A','save',classroom(['u1']),'teacher','forgedAdmin'),/Invalid P0-B2A class index update request/)
  assert.deepEqual([...documents],initial)
})

test('runtime explicitly supplies verified role at all three class mutators',()=>{
  const src=fs.readFileSync(require('node:path').resolve(__dirname,'../functions/index.js'),'utf8')
  const start=src.indexOf('exports.saveManagedClassV2 = onCall(')
  const end=src.indexOf('function normalizeManagedAssignmentSnapshotItems(',start)
  assert.ok(start>0 && end>start)
  const scope=src.slice(start,end)
  assert.equal((scope.match(/actorUid: manager\.uid/g)||[]).length,3)
  assert.doesNotMatch(scope,/actorRole: request\.data/)
  assert.equal((scope.match(/mutateManagedClassSecure\(\{/g)||[]).length,3)
  assert.doesNotMatch(scope,/mutateManagedClassWithIndex\(/)
})
