const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const parser=require('@babel/parser')
const types=['Reading','Listening','Writing','Vocabulary','MockTest']
function expression(type,name) {
 const src=fs.readFileSync(`src/pages/Create${type}.jsx`,'utf8')
 const ast=parser.parse(src,{sourceType:'module',plugins:['jsx']});let found
 const visit=n=>{if(!n||typeof n!=='object')return;if(n.type==='VariableDeclarator'&&n.id?.name===name)found=n.init;for(const [k,v]of Object.entries(n)){if(k==='loc'||k==='tokens')continue;if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v)}}
 visit(ast);assert.ok(found,`${type}.${name}`);return src.slice(found.start,found.end)
}
async function fixture(type,extra={}) {
 const speakingPolicy=await import('../src/services/speakingPolicy.js')
 const delta=await import('../src/services/p8cAssignmentDelta.js')
 const policy=await import('../src/services/aiWritingSponsoredAssignmentPolicy.js')
 const calls={content:[],access:[],ai:[],alerts:[],saved:false}
 const question={id:'Q1',type:'mcq',question:'Pick the synonym.',options:['small','large'],answer:'A'}
 const c={...delta,...policy,...speakingPolicy,speakingConfig:{enabled:false,questions:[]},console:{error:(...x)=>calls.alerts.push(x.map(String).join(' '))},structuredClone,Date,Set,Array,Number,
 title:'Library content',safeTimeLimit:40,timeLimit:40,instructions:'Instructions',dueDate:'',contentType:type==='MockTest'?'mini_mock':'homework',visibility:'private',
 user:{uid:'Teacher001'},profile:{role:'teacher',schoolId:'maxima'},id:'',isEditMode:false,saving:false,loadingExisting:false,readingLoading:false,loadedReadingId:'',readingLoadError:'',selectedWritingMode:'task2',
 assignTo:[],assignmentBaseline:[],students:[],aiActiveClassStudentIds:new Set(),teacherAcademicMembershipReady:true,
 sponsoredSchool:true,sponsoredStatus:'ready',sponsoredSelection:policy.emptyAiSponsoredSelection(),AI_SPONSORED_SCHOOL_ID:'maxima',
 hasTask1:false,hasTask2:true,task1Prompt:'',task2Prompt:'Discuss public transport.',task1Image:'',
 buildSafePayload:()=>({title:'Library content',task1:{image:''},task2:{prompt:'Discuss public transport.'}}),
 audioStoragePath:'private-listening-media/Teacher001/Draft001/audio/file.mp3',audioUrl:'',audioFileName:'file.mp3',audioUploading:false,mapImageUploads:{},draftListeningId:'Draft001',mediaListeningId:'Draft001',originalDocumentVersionRef:{current:null},originalMediaRef:{current:null},parts:[{id:'P1',title:'Part 1',questions:[question]}],
 validateQuestions:()=>true,trimReadingTrailingOptions:x=>x,assertListeningMediaSaveSafe:()=>{},
 questions:[question],getQuestionTypeLabel:()=> 'Multiple choice',cleanQuestions:()=>[question],
 passageMode:'standard',fullPassage:'A sample passage.',paragraphs:[],headings:[],hasSubmissions:false,removeUndefined:x=>x,
 activeSections:{listening:false,reading:false,writing:true},enabledSectionCount:1,isMiniMock:true,listeningIds:[],readingIds:[],writingId:'Writing001',listeningSlotCount:1,readingSlotCount:1,requiredReadingCount:1,fullMockListeningSlotCount:4,fullMockListeningMode:'separate',sectionTimeLimits:{listening:15,reading:30,writing:30},MINI_MOCK_TIMES:{listening:15,reading:30,writing:30},FULL_MOCK_TIMES:{listening:35,reading:60,writing:60},normalizeTimeLimit:(n,f)=>n||f,existingMock:null,
 db:{},doc:(_db,...p)=>p.join('/'),collection:(_db,p)=>p,getProfileSchoolId:p=>p.schoolId,
 addDoc:async(col,payload)=>{calls.content.push({col,payload});return {id:'Content001'}},updateDoc:async(path,payload)=>calls.content.push({path,payload}),
 savePrivateListeningContentCall:async req=>{calls.content.push(req);return {data:{ok:true,listeningId:req.listeningId,version:{revision:1,updatedAt:'2026-11-12'}}}},
 setContentStudentAccessCall:async req=>{calls.access.push(req);return {data:{ok:true}}},setSponsoredPolicyCall:async req=>{calls.ai.push(req);return {data:{ok:true}}},
 setAssignmentBaseline:()=>{},setSaving:()=>{},setSaved:x=>calls.saved=x,setTimeout:()=>{},navigate:p=>{if(p==='/teacher')calls.saved=true},alert:x=>calls.alerts.push(x),window:{confirm:()=>true},
 ...extra}
 if(type==='Vocabulary')c.validate=vm.runInNewContext(`(${expression(type,'validate')})`,c)
 const save=vm.runInNewContext(`(${expression(type,'handleSave')})`,c)
 return {c,calls,save}
}
for(const type of types) {
 test(`${type}: creates valid library content without granting any student or AI access`,async()=>{
  const {calls,save}=await fixture(type);await save()
  assert.deepEqual(calls.alerts,[]);assert.equal(calls.content.length,1);assert.equal(calls.saved,true)
  assert.equal(calls.access.length,0);assert.equal(calls.ai.length,0)
  assert.equal(JSON.stringify(calls.content).includes('assignedTo'),false)
 })
 test(`${type}: optional selected students still receive a scoped assignment`,async()=>{
  const {calls,save}=await fixture(type,{assignTo:['Student001'],students:[{id:'Student001',role:'student',status:'approved',schoolId:'maxima'}]});await save()
  assert.deepEqual(calls.alerts,[]);assert.equal(calls.content.length,1);assert.equal(calls.access.length,1)
  assert.equal(calls.access[0].changes.length,1);assert.equal(calls.access[0].changes[0].studentId,'Student001')
 })
 test(`${type}: missing title remains invalid even without assignments`,async()=>{
  const {calls,save}=await fixture(type,{title:''});await save()
  assert.equal(calls.content.length,0);assert.ok(calls.alerts.length>0)
 })
}
for(const type of ['Writing','MockTest'])test(`${type}: explicit AI opt-in still requires eligible assigned learners`,async()=>{
 const {calls,save}=await fixture(type,{sponsoredSelection:{enabled:true,studentIds:[],configured:false}});await save()
 assert.equal(calls.content.length,0);assert.equal(calls.ai.length,0)
 assert.ok(calls.alerts.some(x=>x.includes('at least one assigned institution student')))
})
test('Listening: private-media validation is not bypassed by empty assignment',async()=>{
 const {calls,save}=await fixture('Listening',{audioStoragePath:'',audioUrl:''});await save()
 assert.equal(calls.content.length,0);assert.ok(calls.alerts.some(x=>x.includes('private audio')))
})
test('Mock: create button is enabled for valid unassigned content',async()=>{
 const {c}=await fixture('MockTest');Object.assign(c,{validListeningSelection:true,hasDuplicateListenings:false,validReadingSelection:true,hasDuplicateReadings:false,validWritingSelection:true})
 assert.equal(Boolean(vm.runInNewContext(expression('MockTest','canCreate'),c)),true)
})

test('Reading: optional assignment does not bypass current class authorization',async()=>{
 const {calls,save}=await fixture('Reading',{assignTo:['ForeignStudent'],students:[]});await save()
 assert.equal(calls.content.length,0);assert.equal(calls.access.length,0)
 assert.ok(calls.alerts.some(x=>x.includes('outside your current active classes')))
})
