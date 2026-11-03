'use strict'

// STEP1000C7T: server-owned Listening create/edit boundary.
// Direct browser writes to /listenings must be denied *together* with rollout
// of this callable. Do not deploy this draft before all writer paths are audited.
const { requireProtectedVault } = require('./p0bVaultSecurity')
const { randomUUID } = require('node:crypto')

const allowedFields = new Set([
  'title','module','contentType','listeningType','visibility',
  'audioUrl','audioFileName','audioStoragePath','instructions','dueDate',
  'timeLimit','schoolId','parts','questions','updatedAt'
])
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const allowedMaps = ['mapImage','mapImageUrl','image','imageUrl']
const caps = { audio:30 * 1048576, map:8 * 1048576 }

function reject(HttpsError, code = 'failed-precondition') {
  throw new HttpsError(code,'Listening media validation failed.')
}
function idOk(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
}
function s(value) { return typeof value === 'string' ? value : '' }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function pathOk(path,owner,docId,kind) {
  if (!idOk(owner) || !idOk(docId) || typeof path !== 'string') return false
  return new RegExp('^private-listening-media/' + owner + '/' + docId + '/' + kind + '/' + uuid + '$').test(path)
}
function boundedData(value,HttpsError) {
  const visit = (v,depth) => {
    if (depth>30) reject(HttpsError,'invalid-argument')
    if (typeof v === 'string') {
      if(v.length>100000) reject(HttpsError,'invalid-argument')
      return
    }
    if (typeof v==='number') {
      if (!Number.isFinite(v)) reject(HttpsError,'invalid-argument')
      return
    }
    if (v===null || typeof v==='boolean') return
    if (Array.isArray(v)) {
      if (v.length>300) reject(HttpsError,'invalid-argument')
      v.forEach(x=>visit(x,depth+1))
      return
    }
    if (!plain(v)) reject(HttpsError,'invalid-argument')
    const keys=Object.keys(v)
    if (keys.length>120 || keys.some(k=>k==='__proto__'||k==='prototype'||k==='constructor'||k.includes('.'))) {
      reject(HttpsError,'invalid-argument')
    }
    for(const k of keys)visit(v[k],depth+1)
  }
  visit(value,0)
  if (Buffer.byteLength(JSON.stringify(value),'utf8')>750000) reject(HttpsError,'invalid-argument')
}
function mapsIn(source,HttpsError) {
  const result=new Map()
  const parts=Array.isArray(source?.parts)&&source.parts.length
    ?source.parts.map(part=>({part,questions:part?.questions||[]}))
    :[{part:{id:''},questions:source?.questions||[]}]
  if(parts.length>24)reject(HttpsError,'invalid-argument')
  for(const {part,questions} of parts) {
    if(!Array.isArray(questions)||questions.length>160)reject(HttpsError,'invalid-argument')
    for(const q of questions) {
      if(!plain(q))reject(HttpsError,'invalid-argument')
      if (q.type!=='map') {
        if (s(q.mapImageStoragePath))reject(HttpsError,'failed-precondition')
        continue
      }
      if(!idOk(q.id)||result.has(q.id))reject(HttpsError,'failed-precondition')
      result.set(q.id,{partId:s(part.id),question:q})
    }
  }
  // Historical source docs also carry flattened questions. Never erase a
  // private reference that exists only in the flattened projection.
  if(Array.isArray(source?.questions)&&Array.isArray(source?.parts)&&source.parts.length){
    for(const q of source.questions){
      if(!plain(q)||q.type!=='map')continue
      if(!idOk(q.id))reject(HttpsError)
      const prior=result.get(q.id)
      if(prior){
        if(!eq(mapMediaSignature(prior.question),mapMediaSignature(q)))reject(HttpsError)
      }else{
        result.set(q.id,{partId:s(q.partId),question:q})
      }
    }
  }
  return result
}
function mapMediaSignature(q) {
  return [s(q.mapImageStoragePath),...allowedMaps.map(k=>s(q[k]))]
}
function eq(a,b){ return JSON.stringify(a)===JSON.stringify(b) }

function validateMediaTransition({before,content,actorUid,listeningId,owner},HttpsError) {
  const oldPath=s(before?.audioStoragePath)
  const oldUrl=s(before?.audioUrl)
  const newPath=s(content.audioStoragePath)
  const newUrl=s(content.audioUrl)
  const needed=new Map()
  const requirePrivate = (path,kind) => {
    if(actorUid!==owner || !pathOk(path,owner,listeningId,kind))reject(HttpsError)
    needed.set(path,kind)
  }
  if (before && newPath===oldPath) {
    if (oldPath.startsWith('private-listening-media/')) {
      if(!pathOk(newPath,owner,listeningId,'audio')||newUrl)reject(HttpsError)
      needed.set(newPath,'audio')
    } else if(newUrl!==oldUrl) reject(HttpsError)
  } else {
    requirePrivate(newPath,'audio')
    if(newUrl)reject(HttpsError)
  }
  if(!newPath && !newUrl)reject(HttpsError)

  const originalMaps=before?mapsIn(before,HttpsError):new Map()
  const proposedMaps=mapsIn(content,HttpsError)
  for (const [qId,{question:q}] of originalMaps) {
    if (s(q.mapImageStoragePath).startsWith('private-listening-media/') && !proposedMaps.has(qId)) {
      reject(HttpsError)
    }
  }
  for (const [qId,{question:q}] of proposedMaps) {
    const old=originalMaps.get(qId)?.question
    const now=mapMediaSignature(q)
    const past=old?mapMediaSignature(old):null
    const path=now[0]
    if (old && eq(now,past)) {
      if(path.startsWith('private-listening-media/')){
        if(!pathOk(path,owner,listeningId,'map')||now.slice(1).some(Boolean))reject(HttpsError)
        needed.set(path,'map')
      }
      // Historical external/legacy map is unchanged: permit editing question text.
    } else {
      requirePrivate(path,'map')
      if(now.slice(1).some(Boolean))reject(HttpsError)
    }
    if(!path && !now.slice(1).some(Boolean))reject(HttpsError)
  }
  return needed
}

function preparePayload(content,HttpsError) {
  if(!plain(content)||Object.keys(content).some(k=>!allowedFields.has(k))){
    reject(HttpsError,'invalid-argument')
  }
  boundedData(content,HttpsError)
  if(!Array.isArray(content.parts)||!content.parts.length)reject(HttpsError,'invalid-argument')
  if(!s(content.title).trim()||s(content.title).length>240||content.module!=='listening'){
    reject(HttpsError,'invalid-argument')
  }
  if(!['private','school'].includes(content.visibility))reject(HttpsError,'invalid-argument')
  if(!Number.isFinite(Number(content.timeLimit))||Number(content.timeLimit)<1||Number(content.timeLimit)>180){
    reject(HttpsError,'invalid-argument')
  }
  if(content.parts.length>24 || content.parts.some(part=>
     !plain(part)||!idOk(part.id)||!Array.isArray(part.questions)||
     part.questions.length>160))reject(HttpsError,'invalid-argument')
  // Prevent a hidden bearer token being embedded in a nested question field.
  const tokens=JSON.stringify(content)
  if(/(?:firebasestorage\.googleapis\.com|storage\.googleapis\.com)[^\"\s]{0,1200}(?:token=|%3[fF]token%3[dD])/i.test(tokens))
    reject(HttpsError,'failed-precondition')
  // Never trust the caller's flat projection; derive it from the *same* parts.
  const clean=structuredClone(content)
  clean.questions=clean.parts.flatMap(part=>(part.questions||[]).map(q=>({
    ...q,partId:part.id,partTitle:part.title
  })))
  if(clean.questions.length>160)reject(HttpsError,'invalid-argument')
  return clean
}

async function verifyObjects({paths,owner,listeningId,schoolId,bucket,HttpsError}) {
  for(const [path,kind] of paths) {
    let metadata
    try { [metadata]=await bucket.file(path).getMetadata() }
    catch(_) {reject(HttpsError)}
    const custom=metadata.metadata||{}
    const sz=Number(metadata.size)
    const type=s(metadata.contentType)
    if(metadata.bucket!==bucket.name||custom.createdBy!==owner||
       custom.listeningId!==listeningId||custom.schoolId!==schoolId||
       custom.privateMediaV1!=='ready_private_v1'||
       Boolean(custom.firebaseStorageDownloadTokens)||
       !Number.isSafeInteger(sz)||sz<1||sz>caps[kind]||
       (kind==='audio'?!type.startsWith('audio/'):
         !['image/png','image/jpeg','image/webp'].includes(type))) reject(HttpsError)
  }
}
// Legacy source timestamps are strings; archive/restore writers use Firestore
// Timestamp objects. Accept a canonical snapshot key, not a client-clock value.
function canonicalUpdatedAt(value) {
  if(value===undefined||value===null)return null
  if(typeof value==='string')return 'str:'+value
  const seconds=value?.seconds, nanos=value?.nanoseconds
  if(Number.isSafeInteger(seconds)&&Number.isSafeInteger(nanos)&&
     nanos>=0&&nanos<1000000000)return `ts:${seconds}:${nanos}`
  return null
}
function updateVersionMatches(expected,doc) {
  if (!plain(expected) ||
      !(expected.revision===null || typeof expected.revision==='string') ||
      !(expected.updatedAt===null || typeof expected.updatedAt==='string')) return false
  const current=canonicalUpdatedAt(doc?.updatedAt)
  // Raw ISO strings are accepted only for the historical C7T offline test
  // fixtures and pre-versioned edit snapshots. Canonical keys are preferred.
  const legacyRaw=typeof doc?.updatedAt==='string'&&doc.updatedAt===expected.updatedAt
  return (doc?.listeningWriteRevision||null)===expected.revision &&
    (current===expected.updatedAt || legacyRaw)
}
function sameFirestoreVersion(a,b) {
  return Boolean(a&&b)&&a.seconds===b.seconds&&a.nanoseconds===b.nanoseconds
}

function createSaveListeningSecure({db,HttpsError,requireAssignmentManager,
  managerCanManageSource,schoolIdOf,bucket,getVaultBucket}) {
  return async request=>{
    const manager=await requireAssignmentManager(request)
    const data=request.data
    if(!plain(data)||Object.keys(data).some(k=>
      !['listeningId','isEditMode','expectedVersion','content'].includes(k)) ||
      !idOk(data.listeningId)||typeof data.isEditMode!=='boolean'){
      reject(HttpsError,'invalid-argument')
    }
    const content=preparePayload(data.content,HttpsError)
    const ref=db.doc('listenings/'+data.listeningId)
    const vault=await requireProtectedVault(getVaultBucket,bucket,HttpsError)
    const existing=await ref.get()
    if(Boolean(existing.exists)!==data.isEditMode)reject(HttpsError,'failed-precondition')
    let before=existing.exists?existing.data():null
    const owner=before?s(before.createdBy||before.teacherId):manager.uid
    const schoolId=before?schoolIdOf(before):
      manager.profile.role==='admin'?s(content.schoolId):schoolIdOf(manager.profile)
    if(!idOk(owner)||!idOk(schoolId)||content.schoolId!==schoolId)reject(HttpsError)
    if(before){
      if(!managerCanManageSource(manager,before)||
         !updateVersionMatches(data.expectedVersion,before))reject(HttpsError)
    }else if(manager.profile.role!=='admin'&&manager.uid!==owner){
      reject(HttpsError)
    }
    const paths=validateMediaTransition({before,content,actorUid:manager.uid,
      listeningId:data.listeningId,owner},HttpsError)
    await verifyObjects({paths,owner,listeningId:data.listeningId,schoolId,bucket:vault,HttpsError})
    let committedVersion=null
    await db.runTransaction(async tx=>{
      const live=await tx.get(ref)
      if(Boolean(live.exists)!==data.isEditMode)reject(HttpsError)
      if(data.isEditMode){
        if(!sameFirestoreVersion(existing.updateTime,live.updateTime)||
           !updateVersionMatches(data.expectedVersion,live.data())||
           !managerCanManageSource(manager,live.data()))reject(HttpsError)
        const now=live.data()
        if(s(now.createdBy||now.teacherId)!==owner||schoolIdOf(now)!==schoolId)reject(HttpsError)
        validateMediaTransition({before:now,content,actorUid:manager.uid,
          listeningId:data.listeningId,owner},HttpsError)
        const updatedAt=new Date().toISOString()
        const listeningWriteRevision=randomUUID()
        tx.update(ref,{...content,updatedAt,listeningWriteRevision})
        committedVersion={revision:listeningWriteRevision,
          updatedAt:canonicalUpdatedAt(updatedAt)}
      }else{
        const updatedAt=new Date().toISOString()
        const listeningWriteRevision=randomUUID()
        tx.create(ref,{
          ...content,updatedAt,
          listeningWriteRevision,createdBy:manager.uid,
          teacherId:manager.profile.role==='teacher'?manager.uid:'',
          teacherIds:manager.profile.role==='teacher'?[manager.uid]:[],
          createdAt:updatedAt,archived:false
        })
        committedVersion={revision:listeningWriteRevision,
          updatedAt:canonicalUpdatedAt(updatedAt)}
      }
    })
    return {ok:true,listeningId:data.listeningId,version:committedVersion}
  }
}
module.exports={
  idOk,pathOk,mapsIn,preparePayload,validateMediaTransition,
  updateVersionMatches,canonicalUpdatedAt,createSaveListeningSecure
}
