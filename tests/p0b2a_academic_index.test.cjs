'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  activeClassStudents, collectStudentIds, mutateManagedClassWithIndex
} = require('../functions/lib/p0bAcademicMembershipIndex')

const T = 'teacherA', SCHOOL = 'maxima'
const INDEX = `schools/${SCHOOL}/teacherAcademicIndex/${T}`
const FieldValue = { arrayUnion: (...items) => ({ __op: 'arrayUnion', items }) }
const current = (ids, extra={}) => ({
  schoolId: SCHOOL, teacherId: T, archived: false,
  name: 'IELTS A', studentIds: ids, ...extra
})

function fakeDb(initial={}) {
  const docs = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]))
  const ref = path => ({ path, id: path.split('/').at(-1) })
  const db = {
    doc: ref,
    collection: name => ({ where(field, op, value) {
      assert.equal(name, 'classes')
      assert.equal(op,'==')
      return { collection: name, field, value }
    } }),
    async runTransaction(fn) {
      const staged = []
      const tx = {
        async get(query) {
          if (query.path) return {
            exists: docs.has(query.path),
            data: () => structuredClone(docs.get(query.path)),
            id: query.id
          }
          return { docs: [...docs.entries()]
            .filter(([path,item]) => path.startsWith(`${query.collection}/`) && item[query.field]===query.value)
            .map(([path,item]) => ({ id: path.split('/').at(-1), exists: true, data:()=>structuredClone(item) })) }
        },
        set(r,data,options){ staged.push(['set',r.path,structuredClone(data),options||{}]) },
        delete(r){ staged.push(['delete',r.path]) }
      }
      const out = await fn(tx)
      // All mutations commit only after the function resolves without error.
      for (const [op,path,value,opt] of staged) {
        if (op==='delete') docs.delete(path)
        else {
          const next = opt.merge ? { ...(docs.get(path)||{}),...value }:value
          for (const [field,v] of Object.entries(next)) {
            if (v?.__op==='arrayUnion') next[field]=[...new Set([...(docs.get(path)?.[field]||[]),...v.items])]
          }
          docs.set(path, structuredClone(next))
        }
      }
      return out
    }
  }
  return { db, docs, ref }
}
const mutation = (db, ref, operation, payload, extra={})=>mutateManagedClassWithIndex({
  db, FieldValue, classRef:ref, teacherId:T,schoolId:SCHOOL,operation,payload,
  studentRefs:operation==='save'?payload.studentIds.map(id=>db.doc(`users/${id}`)):[],
  updatedBy:'admin',now:'2026-10-20T00:00:00Z',...extra
})

test('excludes archived, system ALL, inactive, other school, other teacher, deleted',()=>{
  const excluded = [
    current(['x'],{archived:true}), current(['x'],{system:true}),
    current(['x'],{isSystem:true}), current(['x'],{name:' ALL '}),
    current(['x'],{status:'inactive'}), current(['x'],{deleted:true}),
    current(['x'],{schoolId:'other'}), current(['x'],{teacherId:'other'})
  ]
  assert.deepEqual(collectStudentIds([...excluded,current(['b','a','a'])],T,SCHOOL),['a','b'])
  assert.deepEqual(activeClassStudents(current(['a','a','b']),T,SCHOOL),['a','a','b'])
})

test('class save and membership update are in the same transaction',async()=>{
  const {db,docs,ref}=fakeDb()
  const out=await mutation(db,ref('classes/A'),'save',current(['u1','u2']))
  assert.equal(out.activeStudentCount,2)
  assert.deepEqual(docs.get(INDEX).activeStudentIds,['u1','u2'])
  assert.deepEqual(docs.get('users/u2').teacherIds,[T])
  assert.equal(docs.get('classes/A').schoolId,SCHOOL)
})

test('overlapping classes retain student until last active class removes them',async()=>{
  const {db,docs,ref}=fakeDb()
  await mutation(db,ref('classes/A'),'save',current(['u1','u2']))
  await mutation(db,ref('classes/B'),'save',current(['u2','u3']))
  assert.deepEqual(docs.get(INDEX).activeStudentIds,['u1','u2','u3'])
  await mutation(db,ref('classes/A'),'save',current(['u1']))
  assert.deepEqual(docs.get(INDEX).activeStudentIds,['u1','u2','u3'])
  await mutation(db,ref('classes/B'),'archive',{archived:true})
  assert.deepEqual(docs.get(INDEX).activeStudentIds,['u1'])
  await mutation(db,ref('classes/B'),'archive',{archived:false})
  assert.deepEqual(docs.get(INDEX).activeStudentIds,['u1','u2','u3'])
  await mutation(db,ref('classes/B'),'delete')
  assert.deepEqual(docs.get(INDEX).activeStudentIds,['u1'])
  assert.equal(docs.has('classes/B'),false)
})

test('legacy profile teacherIds never authorize membership',async()=>{
  const {db,docs,ref}=fakeDb({'users/uold':{teacherIds:[T]}})
  await mutation(db,ref('classes/A'),'save',current(['unew']))
  assert.deepEqual(docs.get(INDEX).activeStudentIds,['unew'])
  assert.deepEqual(docs.get('users/uold').teacherIds,[T])
})

test('foreign school class is excluded from school index',async()=>{
  const {db,docs,ref}=fakeDb({'classes/other':current(['foreign'],{schoolId:'other'})})
  await mutation(db,ref('classes/A'),'save',current(['u1']))
  assert.deepEqual(docs.get(INDEX).activeStudentIds,['u1'])
})

test('wrong school for existing index fails closed without writes',async()=>{
  const {db,docs,ref}=fakeDb({[INDEX]:{schoolId:'wrong'},'classes/A':current(['u1'])})
  const before=structuredClone([...docs])
  await assert.rejects(mutation(db,ref('classes/A'),'archive',{archived:true}),/school mismatch/)
  assert.deepEqual([...docs],before)
})

test('invalid teacher mutation and missing class fail closed',async()=>{
  const {db,docs,ref}=fakeDb()
  await assert.rejects(mutation(db,ref('classes/A'),'save',current(['u1'],{teacherId:'other'})),/Invalid class teacher/)
  await assert.rejects(mutation(db,ref('classes/A'),'delete',null),/disappeared/)
  assert.equal(docs.size,0)
})

test('system ALL save cannot produce academic access',async()=>{
  const {db,docs,ref}=fakeDb()
  await mutation(db,ref('classes/S'),'save',current(['u1'],{name:'ALL',system:true}))
  assert.deepEqual(docs.get(INDEX).activeStudentIds,[])
})

test('teacher index documents are scoped to school, not global profile links',async()=>{
  const {db,docs,ref}=fakeDb()
  await mutation(db,ref('classes/C'),'save',current(['u1']))
  const alternate = { schoolId: 'another',teacherId:T,name:'English',studentIds:['otheruser'] }
  await mutation(db,ref('classes/D'),'save',alternate,{schoolId:'another'})
  assert.deepEqual(docs.get(INDEX).activeStudentIds,['u1'])
  assert.deepEqual(docs.get('schools/another/teacherAcademicIndex/teacherA').activeStudentIds,['otheruser'])
})

test('teacher index write contains no AI calls and no browser/client permissions',async()=>{
  const s=require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../functions/lib/p0bAcademicMembershipIndex.js'),'utf8')
  assert.doesNotMatch(s,/httpsCallable|fetch\(|axios\.|openai|provider\.evaluate/i)
  assert.match(s,/tx\.get\(indexRef\)/)
  assert.match(s,/tx\.get\(classesQuery\)/)
  assert.match(s,/tx\.set\(indexRef/)
})

test('class mutation permission no longer derives from historical creator or teacherIds',()=>{
  const s=require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../functions/index.js'),'utf8')
  const body=s.slice(s.indexOf('function managerCanManageClass('),s.indexOf('async function requireManagedClassSchoolActive('))
  assert.match(body,/classTeacherId === manager\.uid/)
  assert.doesNotMatch(body,/createdBy|teacherIds\)/)
})
