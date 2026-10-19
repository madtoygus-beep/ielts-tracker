'use strict'
// P4-D synthetic test harness. Zero network, no Firebase SDK, no real provider.
// Serialized transactions approximate Firestore commit order for deterministic
// contention tests; the separate emulator suite checks actual Firestore writes.
const { createHash } = require('node:crypto')
const { createAiWritingEvaluationService } = require('../../functions/lib/aiWritingEvaluation')
const { createAiWritingSponsoredEvaluationService } = require('../../functions/lib/aiWritingSponsoredEvaluation')
const { createAiWritingSubmissionChoiceService } = require('../../functions/lib/aiWritingSubmissionChoice')
const { prepareAiWritingEvaluation } = require('../../functions/lib/aiWritingGrading')

const STUDENT = 'p4dStudent001'
const TEACHER = 'p4dTeacher001'
const ADMIN = 'p4dAdmin00001'
const WRITING = 'p4dWriting001'
const MOCK = 'p4dMockTest001'
const SCHOOL = 'maxima'
const NOW = Date.parse('2026-10-20T01:00:00.000Z')
const SUBMITTED_AT = '2026-10-20T00:30:00.000Z'
const GRANTED_AT = Date.parse('2026-10-19T23:30:00.000Z')
const essay = n => Array.from({length:n}, (_,i) => `word${i}`).join(' ')
const sha = v => createHash('sha256').update(v).digest('hex')
const FieldValue = { serverTimestamp: () => ({ toMillis: () => NOW }) }
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function memoryDb(initial = {}) {
  const docs = new Map(Object.entries(initial))
  const writes = []
  let endOfQueue = Promise.resolve()
  const snapshot = path => ({
    id: path.split('/').at(-1), exists: docs.has(path),
    data: () => docs.get(path), ref: doc(path)
  })
  function doc(path) {
    return { path, id: path.split('/').at(-1), get: async () => snapshot(path) }
  }
  function query(collection, field, value) {
    return { get: async () => ({
      docs: Array.from(docs.entries())
        .filter(([path, data]) => path.startsWith(`${collection}/`) &&
          path.split('/').length === 2 && data[field] === value)
        .map(([path]) => snapshot(path))
    }) }
  }
  const db = {
    docs, writes, doc,
    collection: name => ({ where: (field, op, value) => {
      if (op !== '==') throw new Error('Only == test queries are supported')
      return query(name, field, value)
    } }),
    runTransaction: async callback => {
      let unlock
      const next = new Promise(resolve => { unlock = resolve })
      const previous = endOfQueue
      endOfQueue = next
      await previous
      try {
        const ops = []
        const tx = {
          get: r => r.get(),
          create: (r, value) => ops.push({kind:'create',path:r.path,value}),
          update: (r, value) => ops.push({kind:'update',path:r.path,value}),
          set: (r, value, options) => ops.push({kind:options?.merge?'merge':'set',path:r.path,value})
        }
        const result = await callback(tx)
        for (const {kind,path} of ops) {
          if (kind === 'create' && docs.has(path)) throw new Error(`Test duplicate create: ${path}`)
          if (kind === 'update' && !docs.has(path)) throw new Error(`Test missing update: ${path}`)
        }
        for (const {kind,path,value} of ops) {
          docs.set(path, ['update','merge'].includes(kind) ? { ...(docs.get(path) || {}), ...value } : value)
          writes.push({kind,path})
        }
        return result
      } finally { unlock() }
    }
  }
  return db
}

const criterion = {band:6,explanation:'Local synthetic feedback.',evidence:''}
function validReport(context='homework', count=300) {
  return {
    isAiEstimate: true, teacherFinalScore: null, context,
    writingMode: 'task2_only', isProvisionalMockEstimate: context === 'mock',
    task1: null, task2: {wordCount: count, feedbackOnly:false, estimatedBand:6,
      criteria: {taskAchievementOrResponse:criterion, coherenceAndCohesion:criterion,
        lexicalResource:criterion, grammaticalRangeAndAccuracy:criterion}},
    estimatedBand:6, feedbackOnly:false
  }
}

function world({context='homework', credits=2, creditEnabled=true, pilot=true,
  choice='ai', billing='student_credit', words=300, grantIssuer=ADMIN,
  funded=true, authorRole='admin', provider=null, providerEnabled=true,
  sponsoredEnabled=true, schoolActive=true, userStatus='approved',
  accessStatus='active', monthly=null, attemptNumber=1, jobStatus=null,
  jobBilling=null}={}) {
  const mock = context === 'mock'
  const contentId = mock ? MOCK : WRITING
  const contentType = mock ? 'mock' : 'writing'
  const sourceCollection = mock ? 'mockTests' : 'writingHomeworks'
  const submissionCollection = mock ? 'mockSubmissions' : 'writingSubmissions'
  const source = mock ? {schoolId:SCHOOL, teacherId:TEACHER, writingId:WRITING,
    enabledSections:{writing:true}} : {schoolId:SCHOOL,teacherId:TEACHER,
    contentType:'task2_only',task2:{prompt:'Discuss education policy.'}}
  const writingSource = {schoolId:SCHOOL, contentType:'task2_only',
    task2:{prompt:'Discuss education policy.'}}
  const submission = { uid:STUDENT, studentId:STUDENT, schoolId:SCHOOL,
    attemptNumber, submittedAt:SUBMITTED_AT,
    ...(mock ? {mockTestId:MOCK, status:'submitted', writingId:WRITING,
      writingMode:'task2_only', enabledSections:{writing:true},
      writingAnswers:{task1:'',task2:essay(words)}}
    : {writingId:WRITING,writingMode:'task2_only',task1Answer:'',
      task2Answer:essay(words), aiReviewChoice:choice,aiBillingMode:billing}) }
  const submissionPath = `${submissionCollection}/${STUDENT}_${contentId}`
  const policy = {schemaVersion:2,schoolId:SCHOOL,enabled:funded,
    billing:'institution',context,contentId,contentType,sourceCollection,
    studentIds:funded?[STUDENT]:[],
    grants:funded?{[STUDENT]:{grantedBy:grantIssuer,grantedAtMs:GRANTED_AT}}:{} }
  const base = {
    [`users/${STUDENT}`]:{role:'student',uid:STUDENT,studentId:STUDENT,
      schoolId:SCHOOL,status:userStatus,accountType:'institution'},
    [`users/${ADMIN}`]:{role:authorRole,schoolId:SCHOOL,status:'approved',accountType:'institution'},
    [`users/${TEACHER}`]:{role:'teacher',schoolId:SCHOOL,status:'approved',accountType:'institution'},
    [`schools/${SCHOOL}`]:{status:schoolActive?'active':'inactive'},
    [`aiWritingSchoolSettings/${SCHOOL}`]:{schoolId:SCHOOL,pilotEnabled:pilot},
    [`aiWritingStudentAccess/${STUDENT}`]:{uid:STUDENT,studentId:STUDENT,
      schoolId:SCHOOL,accountType:'institution',enabled:creditEnabled,
      creditsRemaining:credits,creditsUsedTotal:0},
    [`${sourceCollection}/${contentId}`]:source,
    [submissionPath]:submission,
    [`studentAccess/${STUDENT}_${contentType}_${contentId}`]:{
      uid:STUDENT,schoolId:SCHOOL,contentId,contentType,sourceCollection,
      accessType:'assignment',status:accessStatus},
    [`aiWritingSponsoredPolicies/${contentType}_${contentId}`]:policy,
    'classes/p4dClass001':{name:'IELTS A',teacherId:TEACHER,schoolId:SCHOOL,
      status:'active',studentIds:[STUDENT]}
  }
  if (mock) base[`writingHomeworks/${WRITING}`] = writingSource
  if (monthly) base['aiWritingMonthlyUsage/maxima_202610'] = monthly
  const prepared = prepareAiWritingEvaluation({context,
    source:mock?writingSource:source,submission})
  const jobId = sha(['ai-writing-v1',STUDENT,context,contentId,attemptNumber].join('\0'))
  if (jobStatus) base[`aiWritingEvaluations/${jobId}`] = {
    jobId,studentId:STUDENT,schoolId:SCHOOL,context,contentId,
    attemptNumber,fingerprint:sha(JSON.stringify(prepared)), status:jobStatus,
    billingMode:jobBilling||'student_credit',leaseId:'oldLease',leaseUntilMs:NOW-1000,
    activeLedgerId:'oldLedger',month:'202610'
  }
  const db = memoryDb(base)
  let calls = 0
  const realProvider = async (...args) => {
    calls += 1
    return provider ? provider(...args) : {report:validReport(context,words),model:'local-stub'}
  }
  const personal = createAiWritingEvaluationService({
    db, FieldValue, HttpsError,
    requireStudent:async()=>({uid:STUDENT,schoolId:SCHOOL}),
    requireStudentAttemptSource:async()=>true,
    submissionContentConfigFor:()=>({sourceCollection}),
    findCurrentSubmissionRecord:async()=>({ref:db.doc(submissionPath),data:db.docs.get(submissionPath)}),
    getOpenSubmissionAttemptControl:async()=>null,
    schoolIdOf:d=>d?.schoolId,getMockEnabledSections:d=>d?.enabledSections||{},
    getMockWritingMode:()=> 'task2_only',
    provider:realProvider,getApiKey:()=> 'sk-local-synthetic-not-a-real-key',
    providerEnabled:()=>providerEnabled,now:()=>NOW
  })
  const sponsored = createAiWritingSponsoredEvaluationService({
    db, FieldValue, schoolIdOf:d=>d?.schoolId,
    getMockEnabledSections:d=>d?.enabledSections||{},
    getMockWritingMode:()=> 'task2_only',provider:realProvider,
    getApiKey:()=> 'sk-local-synthetic-not-a-real-key',
    providerEnabled:()=>sponsoredEnabled,
    findCurrentSubmissionRecord:async()=>({ref:db.doc(submissionPath),data:db.docs.get(submissionPath)}),
    submissionContentConfigFor:()=>({}),now:()=>NOW
  })
  const choiceService = createAiWritingSubmissionChoiceService({
    db,HttpsError,requireStudent:async()=>({uid:STUDENT,schoolId:SCHOOL}),
    schoolIdOf:d=>d?.schoolId,accountTypeOf:d=>d?.accountType || 'institution',
    providerEnabled:()=>providerEnabled,sponsoredEnabled:()=>sponsoredEnabled
  })
  const event = (before=null) => ({data:{
    before:before?{exists:true,data:()=>before}:{exists:false},
    after:{exists:true,ref:db.doc(submissionPath),data:()=>db.docs.get(submissionPath)}
  }})
  return {
    db,docs:db.docs,writes:db.writes,context,contentId,contentType,
    sourceCollection,submissionCollection,submissionPath,
    jobId,submission,prepared,policy,personal,sponsored,choiceService,
    event, calls:()=>calls,
    request:{data:{context,contentId}},
    access:()=>db.docs.get(`aiWritingStudentAccess/${STUDENT}`),
    month:()=>db.docs.get('aiWritingMonthlyUsage/maxima_202610'),
    job:()=>db.docs.get(`aiWritingEvaluations/${jobId}`),
    policyDoc:()=>db.docs.get(`aiWritingSponsoredPolicies/${contentType}_${contentId}`),
  }
}
module.exports = {
  world, memoryDb, validReport, essay, sha, FieldValue, HttpsError,
  STUDENT, TEACHER, ADMIN, WRITING, MOCK, SCHOOL, NOW, SUBMITTED_AT, GRANTED_AT
}
