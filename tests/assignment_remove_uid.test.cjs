const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),vm=require('node:vm')
const src=fs.readFileSync('src/pages/TeacherDashboard.jsx','utf8')
const start=src.indexOf('  const removeHomeworkFromStudent =')
const end=src.indexOf('\n  const archiveReadingHomework =',start)
function fixture({reject=false,confirm=true,identity='AbCStudent01'}={}) {
 const store=new Map([[identity,{accessType:'assignment'}],['OtherStudent02',{accessType:'assignment'}]])
 const lowerTwin=identity.toLowerCase();if(lowerTwin!==identity)store.set(lowerTwin,{accessType:'assignment'})
 let ui={writing_Test01:[...store.keys()]},refresh=0
 const requests=[],alerts=[],submissions={answer:'untouched',score:6}
 const c={window:{confirm:()=>confirm},normalizeAssignmentId:x=>String(x||'').trim().toLowerCase(),
 getStudentPrimaryAssignmentId:s=>s.uid||s.authUid||s.id||'',assignmentAccessKey:(t,id)=>`${t}_${id}`,
 setAssignmentStudentIdsByContent:fn=>ui=fn(ui),queueAssignmentRemoval:async(_key,fn)=>{try{return await fn()}finally{refresh++}},
 setContentStudentAccessCall:async req=>{requests.push(req);if(reject)throw Error('denied');for(const change of req.changes){const current=store.get(change.studentId);if(!current||current.accessType!=='assignment')throw Error('Assignment not found');current.accessType='unassigned_archive'}return {data:{ok:true}}},
 alert:x=>alerts.push(x),console:{error:()=>{}}}
 const remove=vm.runInNewContext(src.slice(start,end)+'\nremoveHomeworkFromStudent',c)
 return {remove,store,requests,alerts,submissions,ui:()=>ui,refresh:()=>refresh,identity,lowerTwin}
}
for(const type of ['reading','listening','writing','vocabulary','mock'])test(`${type}: removal uses exact mixed-case Firebase UID`,async()=>{
 const f=fixture();await f.remove({id:'Test01',title:'Test'},type,{uid:f.identity,name:'Synthetic student'})
 assert.equal(f.alerts.length,0);assert.equal(f.requests.length,1)
 assert.equal(f.requests[0].changes[0].studentId,f.identity)
 assert.equal(f.store.get(f.identity).accessType,'unassigned_archive')
 assert.equal(f.store.get(f.lowerTwin).accessType,'assignment')
 assert.equal(f.store.get('OtherStudent02').accessType,'assignment')
 assert.deepEqual(f.submissions,{answer:'untouched',score:6})
})
test('optimistic UI removes only the exact intended student, not a lowercase twin',async()=>{
 const f=fixture();await f.remove({id:'Test01'},'writing',{id:f.identity})
 assert.equal(f.ui().writing_Test01.includes(f.identity),false)
 assert.equal(f.ui().writing_Test01.includes(f.lowerTwin),true)
})
test('server denial does not mutate saved assignments and refreshes canonical list',async()=>{
 const f=fixture({reject:true});await f.remove({id:'Test01'},'writing',{authUid:f.identity})
 assert.equal(f.alerts.length,1);assert.equal(f.refresh(),1)
 assert.equal(f.store.get(f.identity).accessType,'assignment')
})
test('cancelled confirmation sends no mutation',async()=>{
 const f=fixture({confirm:false});await f.remove({id:'Test01'},'writing',{uid:f.identity})
 assert.equal(f.requests.length,0);assert.equal(f.store.get(f.identity).accessType,'assignment')
})
