'use strict'
// Step786: isolated security regressions. No Firebase SDK, no network, no
// Production calls. Real Firestore callable/emulator suite is a later gate.
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { mutateManagedClassSecure, RELEASE, GATE_ID } =
  require('../functions/lib/p0bManagedClassSecureWriter')

const S = 'maxima', T = 'teacher786', A = 'admin786', C = 'classes/class786'
const GATE = `schools/${S}/classWriteGate/${GATE_ID}`
const INDEX = `schools/${S}/teacherAcademicIndex/${T}`
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code } }
const FieldValue = { arrayUnion: (...ids) => ({ __union: ids }) }
const stamp = n => ({ n, isEqual: rhs => rhs?.n === n })
const classroom = (ids=['u1'], extra={}) => ({
  name: 'IELTS 11', description: '', color: 'purple',
  schoolId: S, teacherId: T, teacherIds: [T], classSchemaVersion: 1,
  archived: false, studentIds: ids, createdBy: A, createdAt: '2026-10-21T01:00:00Z',
  updatedBy: A, updatedAt: '2026-10-21T01:00:00Z', ...extra
})
function fixture(extra={}) {
  const original={
    [GATE]: {schemaVersion:1,phase:'open',release:RELEASE},
    [`schools/${S}`]: {status:'active'},
    [`users/${A}`]: {role:'admin',status:'approved'},
    [`users/${T}`]: {role:'teacher',schoolId:S,status:'approved'},
    'users/u1':{role:'student',schoolId:S,accountType:'institution',status:'approved'},
    'users/u2':{role:'student',schoolId:S,accountType:'institution',status:'approved'},
    [INDEX]: {schemaVersion:1,source:'managed_active_classes',schoolId:S,teacherId:T,activeStudentIds:['u1']},
    ...extra
  }
  const docs=new Map(Object.entries(original).map(([p,data])=>[p,{data:structuredClone(data),v:1}]))
  const ref=path=>({path,id:path.split('/').at(-1)})
  const snapshot = path => {
    const entry=docs.get(path)
    return { exists: Boolean(entry), id: path.split('/').at(-1),
      updateTime: entry ? stamp(entry.v) : null,
      data:()=>entry ? structuredClone(entry.data) : undefined }
  }
  let beforeTx=()=>{}
  let mutationCount=0
  const db={
    doc:ref,
    collection:coll=>({ where(field,op,value){
      assert.equal(coll,'classes');assert.equal(field,'teacherId');assert.equal(op,'==')
      return {collection:coll,field,value}
    }}),
    async runTransaction(callback) {
      beforeTx()
      const operations=[]
      const tx={
        async get(r){
          if(r.path)return snapshot(r.path)
          return {docs:[...docs.entries()].filter(([p,x])=>p.startsWith(r.collection+'/') && x.data[r.field]===r.value).map(([p])=>snapshot(p))}
        },
        getAll:async(...refs)=>refs.map(r=>snapshot(r.path)),
        set(r,data,opt={}){operations.push(['set',r.path,structuredClone(data),opt])},
        delete(r){operations.push(['delete',r.path])}
      }
      const out=await callback(tx)
      for(const [op,path,data,opt] of operations) {
        mutationCount++
        if(op==='delete'){ docs.delete(path); continue }
        const before=docs.get(path)
        const next=opt.merge?{...(before?.data||{}),...data}:data
        for(const [k,v] of Object.entries(next))if(v?.__union)next[k]=[...new Set([...(before?.data[k]||[]),...v.__union])]
        docs.set(path,{data:structuredClone(next),v:(before?.v||0)+1})
      }
      return out
    }
  }
  const current = path => docs.get(path)?.data
  const version = path => snapshot(path).updateTime
  const change = (operation,payload=null,other={}) => mutateManagedClassSecure({
    db,FieldValue,HttpsError,classRef:ref(C),teacherId:T,schoolId:S,
    operation,payload,actorUid:A,expectedClassUpdateTime:operation==='create'?null:version(C),
    now:'2026-10-21T02:00:00Z',...other
  })
  const directlySet=(path,data)=>{
    const prev=docs.get(path);docs.set(path,{data:structuredClone(data),v:(prev?.v||0)+1})
  }
  return {db,docs,ref,version,current,change,directlySet,setBeforeTx:fn=>beforeTx=fn,
    get mutations(){return mutationCount}}
}
const denied=(p,code)=>assert.rejects(p,e=>(!code||e?.code===code)&&e instanceof HttpsError)

test('closed or absent server gate fails before every write',async()=>{
  for(const gate of [undefined,{schemaVersion:1,phase:'frozen',release:RELEASE},
    {schemaVersion:1,phase:'open',release:'unverified'}]){
    const f=fixture()
    if(!gate)f.docs.delete(GATE);else f.directlySet(GATE,gate)
    await denied(f.change('create',classroom()),'failed-precondition')
    assert.equal(f.mutations,0)
    assert.equal(f.current(C),undefined)
  }
})
test('admin create writes class and approved roster index atomically',async()=>{
  const f=fixture()
  const result=await f.change('create',classroom(['u1','u2']))
  assert.deepEqual(result.class.studentIds,['u1','u2'])
  assert.deepEqual(f.current(INDEX).activeStudentIds,['u1','u2'])
  assert.deepEqual(f.current('users/u2').teacherIds,[T])
  assert.equal(f.current(C).name,'IELTS 11')
})
test('teacher cannot create a new grant through historical teacherIds or stale role',async()=>{
  const f=fixture()
  await denied(f.change('create',classroom(['u1','u2']),{actorUid:T}),'permission-denied')
  assert.equal(f.mutations,0)
  await f.change('create',classroom(['u1']),{actorUid:T})
  assert.deepEqual(f.current(INDEX).activeStudentIds,['u1'])
})
test('admin demotion between preflight and transaction blocks previously-authorized addition',async()=>{
  const f=fixture()
  f.setBeforeTx(()=>f.directlySet('users/'+A,{role:'teacher',status:'approved',schoolId:S}))
  await denied(f.change('create',classroom(['u1','u2'])),'permission-denied')
  assert.equal(f.mutations,0)
})
test('actor archived / deleting / wrong school fail closed',async()=>{
  for(const fields of [{archived:true},{permanentDeleteInProgress:true},{deleted:true},{status:'pending'}]){
    const f=fixture();f.directlySet('users/'+A,{role:'admin',status:'approved',...fields})
    await denied(f.change('create',classroom()),'permission-denied')
    assert.equal(f.mutations,0)
  }
  const f=fixture()
  f.directlySet('users/'+T,{role:'teacher',schoolId:'other',status:'approved'})
  await denied(f.change('create',classroom(['u1']),{actorUid:T}),'permission-denied')
})
test('inactive school/teacher prevents new grants',async()=>{
  const f=fixture()
  f.directlySet(`schools/${S}`,{status:'inactive'})
  await denied(f.change('create',classroom()),'failed-precondition')
  const g=fixture()
  g.directlySet(`users/${T}`,{role:'teacher',schoolId:S,status:'approved',archived:true})
  await denied(g.change('create',classroom()),'failed-precondition')
})
test('student status and school verified INSIDE transaction, not only preflight',async()=>{
  for(const student of [{role:'student',schoolId:'wrong',status:'approved'},
    {role:'student',schoolId:S,status:'approved',archived:true},
    {role:'student',schoolId:S,status:'approved',accountType:'individual'},
    {role:'student',schoolId:S,status:'approved',deleted:true}]){
    const f=fixture();f.setBeforeTx(()=>f.directlySet('users/u2',student))
    await denied(f.change('create',classroom(['u2'])),'failed-precondition')
    assert.equal(f.mutations,0)
  }
})
test('old edit cannot reopen a class archived after preflight',async()=>{
  const f=fixture({[C]:classroom(['u1'])})
  const expected=f.version(C)
  f.setBeforeTx(()=>f.directlySet(C,{...f.current(C),archived:true,updatedAt:'new'}))
  await denied(f.change('edit',classroom(['u1']),{expectedClassUpdateTime:expected}),'aborted')
  assert.equal(f.current(C).archived,true)
  assert.equal(f.mutations,0)
})
test('old edit cannot recreate a class deleted after preflight',async()=>{
  const f=fixture({[C]:classroom(['u1'])})
  const expected=f.version(C)
  f.setBeforeTx(()=>f.docs.delete(C))
  await denied(f.change('edit',classroom(['u1']),{expectedClassUpdateTime:expected}),'not-found')
  assert.equal(f.current(C),undefined)
  assert.equal(f.mutations,0)
})
test('stale archive and delete cannot mutate a concurrently changed class',async()=>{
  for(const operation of ['archive','delete']){
    const f=fixture({[C]:classroom(['u1'])})
    const expected=f.version(C)
    f.setBeforeTx(()=>f.directlySet(C,{...f.current(C),name:'Changed by other admin'}))
    await denied(f.change(operation,operation==='archive'?{archived:true}:null,
      {expectedClassUpdateTime:expected}),'aborted')
    assert.equal(f.current(C).name,'Changed by other admin')
    assert.equal(f.mutations,0)
  }
})
test('edit cannot forge system class and cannot revive archive in same-version payload',async()=>{
  const f=fixture({[C]:classroom(['u1'],{archived:true})})
  await denied(f.change('edit',classroom(['u1'])),'aborted')
  await denied(f.change('edit',classroom(['u1'],{name:'ALL',archived:true})),'failed-precondition')
  assert.equal(f.mutations,0)
})
test('system ALL class accepts only admin and never writes empty teacherId into profiles',async()=>{
  const existing=classroom(['u1'],{name:'ALL',teacherId:'',teacherIds:[],system:true})
  const f=fixture({[C]:existing})
  const next={...existing,description:'New',updatedBy:A}
  const result=await f.change('edit',next,{teacherId:''})
  assert.equal(result.class.description,'New')
  assert.equal(f.current('users/u1').teacherIds,undefined)
  assert.deepEqual(f.current(INDEX).activeStudentIds,['u1'])
  await denied(f.change('edit',next,{teacherId:'',actorUid:T}),'permission-denied')
})
test('admin archive revokes and teacher unarchive cannot regrant',async()=>{
  const f=fixture({[C]:classroom(['u1'])})
  await f.change('archive',{archived:true})
  assert.deepEqual(f.current(INDEX).activeStudentIds,[])
  await denied(f.change('archive',{archived:false},{actorUid:T}),'permission-denied')
  assert.equal(f.current(C).archived,true)
  await f.change('archive',{archived:false})
  assert.deepEqual(f.current(INDEX).activeStudentIds,['u1'])
})
test('ownership mismatch / index poison / missing teacher fail before mutation',async()=>{
  const f=fixture({[C]:classroom(['u1'])})
  await denied(f.change('edit',classroom(['u1']),{teacherId:'someoneElse'}),'invalid-argument')
  f.directlySet(INDEX,{schoolId:S,teacherId:'attacker',source:'managed_active_classes',schemaVersion:1,activeStudentIds:['u1']})
  await denied(f.change('edit',classroom(['u1'])),'failed-precondition')
  assert.equal(f.mutations,0)
})
test('freeze read takes place inside same transaction as writes',async()=>{
  const f=fixture()
  f.setBeforeTx(()=>f.directlySet(GATE,{schemaVersion:1,phase:'frozen',release:RELEASE}))
  await denied(f.change('create',classroom()),'failed-precondition')
  assert.equal(f.mutations,0)
})
test('runtime uses new guarded writer across all three callables and keeps old Rules untouched',()=>{
  const src=readFileSync(join(__dirname,'../functions/index.js'),'utf8')
  const start=src.indexOf('exports.saveManagedClass = onCall(')
  const end=src.indexOf('function normalizeManagedAssignmentSnapshotItems(',start)
  const block=src.slice(start,end)
  assert.equal((block.match(/mutateManagedClassSecure\(\{/g)||[]).length,3)
  assert.equal((block.match(/expectedClassUpdateTime:/g)||[]).length,3)
  assert.equal((block.match(/actorUid: manager\.uid/g)||[]).length,3)
  assert.doesNotMatch(block,/mutateManagedClassWithIndex\(/)
  assert.doesNotMatch(block,/db\.batch\(/)
  const gate=readFileSync(join(__dirname,'../functions/lib/p0bManagedClassSecureWriter.js'),'utf8')
  assert.match(gate,/await tx\.get\(gateRef\)/)
  assert.match(gate,/await tx\.get\(actorRef\)/)
  assert.match(gate,/await tx\.get\(classRef\)/)
  assert.match(gate,/await tx\.getAll\(\.\.\.refs\)/)
})
