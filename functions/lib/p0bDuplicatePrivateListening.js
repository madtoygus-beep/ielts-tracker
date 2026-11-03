'use strict'
// STEP1000C7V - OFFLINE REVIEW ONLY. Not deployed.
// A secure server-only duplicate action. Historical public bearer links and
// staging objects cannot become the media of a fresh Listening document.
const { createHash, randomUUID } = require('node:crypto')
const { requireProtectedVault } = require('./p0bVaultSecurity')
const { idOk, pathOk, mapsIn, preparePayload, validateMediaTransition } =
  require('./p0bListeningSecureWrite')

const mediaKeys = ['mapImage', 'mapImageUrl', 'image', 'imageUrl']
const sizes = { audio:30*1048576, map:8*1048576 }
const isRecord = x => Boolean(x)&&typeof x==='object'&&!Array.isArray(x)
const text = x => typeof x==='string'?x:''
const digest = x => createHash('sha256').update(x).digest('hex')
const deny = (HttpsError, code='failed-precondition') => {
  throw new HttpsError(code,'Listening cannot be duplicated securely. Migrate old media before retrying.')
}
function targetMediaPath(owner,targetId,sourcePath,kind) {
  if(!idOk(owner)||!idOk(targetId)||!['audio','map'].includes(kind)||
      typeof sourcePath!=='string')throw Error('Invalid private duplicate identity')
  const hash=digest(owner+'\x1f'+targetId+'\x1f'+kind+'\x1f'+sourcePath)
  const uuid=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`
  return `private-listening-media/${owner}/${targetId}/${kind}/${uuid}`
}
function parse(data,HttpsError) {
  if(!isRecord(data)||Object.keys(data).length!==2||
      Object.keys(data).some(k=>!['sourceListeningId','targetListeningId'].includes(k))||
      !idOk(data.sourceListeningId)||!idOk(data.targetListeningId)||
      data.sourceListeningId===data.targetListeningId)deny(HttpsError,'invalid-argument')
  return {sourceId:data.sourceListeningId,targetId:data.targetListeningId}
}
function validReturnTarget(existing,manager,schoolId,sourceId,fp,managerCanManageSource,schoolIdOf) {
  return existing?.duplicateRequestFingerprint===fp &&
    existing?.duplicateSourceId===sourceId &&
    existing?.createdBy===manager.uid &&
    schoolIdOf(existing)===schoolId && managerCanManageSource(manager,existing)
}
function isSameTime(a,b) {
  return !!(a&&b&&a.seconds===b.seconds&&a.nanoseconds===b.nanoseconds)
}
function checkedMeta(meta,details,HttpsError) {
  const {bucketName,owner,listeningId,schoolId,kind}=details
  const custom=meta?.metadata||{}
  const size=Number(meta?.size),mime=text(meta?.contentType)
  if(!meta||meta.bucket!==bucketName||!text(meta.generation)||
     custom.createdBy!==owner||custom.listeningId!==listeningId||
     custom.schoolId!==schoolId||custom.privateMediaV1!=='ready_private_v1'||
     Boolean(custom.firebaseStorageDownloadTokens)||
     !Number.isSafeInteger(size)||size<1||size>sizes[kind]||
     (kind==='audio'?!mime.startsWith('audio/'):
       !['image/png','image/jpeg','image/webp'].includes(mime)))deny(HttpsError)
  return meta
}
async function maybeMeta(file) {
  try {const [meta]=await file.getMetadata();return meta}
  catch(e){if(Number(e?.code)===404)return null;throw e}
}
function cloneAsPrivate(source,sourceId,targetId,uid,schoolId,HttpsError) {
  const owner=text(source.createdBy||source.teacherId)
  if(!idOk(owner)||!pathOk(source.audioStoragePath,owner,sourceId,'audio')||
      text(source.audioUrl))deny(HttpsError)
  const existingMaps=mapsIn(source,HttpsError)
  // Never silently drop a flat-only historical map on duplicate.
  const nestedIds=new Set((Array.isArray(source.parts)?source.parts:[])
    .flatMap(part=>Array.isArray(part?.questions)?part.questions:[])
    .filter(q=>q?.type==='map').map(q=>q.id))
  if(nestedIds.size!==existingMaps.size)deny(HttpsError)
  for(const entry of existingMaps.values()){
    const q=entry.question
    if(!pathOk(q.mapImageStoragePath,owner,sourceId,'map')||
       mediaKeys.some(k=>text(q[k])))deny(HttpsError)
  }
  const parts=structuredClone(source.parts)
  if(!Array.isArray(parts)||!parts.length)deny(HttpsError)
  const paths=new Map([[source.audioStoragePath,{kind:'audio'}]])
  for(const part of parts){
    if(!isRecord(part)||!Array.isArray(part.questions))deny(HttpsError)
    for(const q of part.questions){
      if(!isRecord(q))deny(HttpsError)
      if(q.type!=='map')continue
      const oldPath=text(q.mapImageStoragePath)
      if(!pathOk(oldPath,owner,sourceId,'map')||mediaKeys.some(k=>text(q[k])))deny(HttpsError)
      paths.set(oldPath,{kind:'map'})
      q.mapImageStoragePath=targetMediaPath(uid,targetId,oldPath,'map')
      for(const k of mediaKeys)q[k]=''
    }
  }
  const content=preparePayload({
    title:(text(source.title).slice(0,235)+' Copy').trim(),
    module:'listening',contentType:source.contentType||source.listeningType||'full_listening',
    listeningType:source.listeningType||source.contentType||'full_listening',
    visibility:'private',schoolId,
    audioUrl:'',audioFileName:text(source.audioFileName),
    audioStoragePath:targetMediaPath(uid,targetId,source.audioStoragePath,'audio'),
    instructions:text(source.instructions),dueDate:source.dueDate||'',
    timeLimit:Number(source.timeLimit)||30,parts,
    questions:[],updatedAt:new Date().toISOString()
  },HttpsError)
  // Apply the exact same fail-closed nested map and bound-audio rules as save.
  validateMediaTransition({before:null,content,actorUid:uid,
    listeningId:targetId,owner:uid},HttpsError)
  return {content,paths,sourceOwner:owner}
}
function createDuplicatePrivateListeningSecure({db,HttpsError,requireAssignmentManager,
  managerCanManageSource,schoolIdOf,bucket,getVaultBucket}) {
  return async request=>{
    const manager=await requireAssignmentManager(request)
    const {sourceId,targetId}=parse(request.data,HttpsError)
    const sourceRef=db.doc('listenings/'+sourceId)
    const targetRef=db.doc('listenings/'+targetId)
    const fingerprint=digest(manager.uid+'\x1f'+sourceId+'\x1f'+targetId)
    const vault=await requireProtectedVault(getVaultBucket,bucket,HttpsError)
    const sourceSnap=await sourceRef.get()
    if(!sourceSnap.exists)deny(HttpsError,'not-found')
    const source=sourceSnap.data()||{}
    const schoolId=schoolIdOf(source)
    if(!idOk(schoolId)||!managerCanManageSource(manager,source)||
       source.deleted===true||source.deleteInProgress===true||source.archived===true||
       (manager.profile.role==='teacher'&&schoolId!==schoolIdOf(manager.profile)))
      deny(HttpsError,'permission-denied')
    const targetAlready=await targetRef.get()
    if(targetAlready.exists){
      if(!validReturnTarget(targetAlready.data(),manager,schoolId,sourceId,
           fingerprint,managerCanManageSource,schoolIdOf))deny(HttpsError)
      return {ok:true,listeningId:targetId,reused:true}
    }
    const {content,paths,sourceOwner}=cloneAsPrivate(
      source,sourceId,targetId,manager.uid,schoolId,HttpsError)
    // Copy exact source generations into target-bound namespace; create-only.
    // Deterministic paths make retries idempotent and prevent duplicate bytes.
    for(const [originalPath,{kind}] of paths){
      const src=vault.file(originalPath)
      const sourceMeta=checkedMeta(await maybeMeta(src),{
        bucketName:vault.name,owner:sourceOwner,listeningId:sourceId,schoolId,kind
      },HttpsError)
      const destPath=targetMediaPath(manager.uid,targetId,originalPath,kind)
      const dest=vault.file(destPath)
      const metadata={
        createdBy:manager.uid,schoolId,listeningId:targetId,
        privateMediaV1:'ready_private_v1',
        duplicatedFromPathSha256:digest(originalPath),
        duplicatedFromGeneration:String(sourceMeta.generation)
      }
      try{
        await vault.file(originalPath,{generation:sourceMeta.generation}).copy(dest,{
          preconditionOpts:{ifGenerationMatch:0},contentType:sourceMeta.contentType,
          cacheControl:'private, no-store',metadata
        })
      }catch(e){if(Number(e?.code)!==412)throw e}
      const final=checkedMeta(await maybeMeta(dest),{
        bucketName:vault.name,owner:manager.uid,listeningId:targetId,schoolId,kind
      },HttpsError)
      if(final.metadata?.duplicatedFromPathSha256!==digest(originalPath)||
         final.metadata?.duplicatedFromGeneration!==String(sourceMeta.generation)||
         String(final.size)!==String(sourceMeta.size)||
         (sourceMeta.crc32c&&final.crc32c&&sourceMeta.crc32c!==final.crc32c)||
         (sourceMeta.md5Hash&&final.md5Hash&&sourceMeta.md5Hash!==final.md5Hash))deny(HttpsError)
    }
    const now=new Date().toISOString()
    const next={...content,createdBy:manager.uid,createdAt:now,updatedAt:now,
      teacherId:manager.profile.role==='teacher'?manager.uid:'',
      teacherIds:manager.profile.role==='teacher'?[manager.uid]:[],
      archived:false,listeningWriteRevision:randomUUID(),
      duplicateSourceId:sourceId,duplicateRequestFingerprint:fingerprint}
    // The database cannot atomically commit GCS copies. On failure, leave
    // deterministic copies for a safe retry/reconciliation rather than delete
    // another concurrent caller's media and corrupt its committed document.
    // A read-only orphan report is required before any production rollout.
    const operation=await db.runTransaction(async tx=>{
      const [freshSource,freshTarget]=await Promise.all([tx.get(sourceRef),tx.get(targetRef)])
      if(freshTarget.exists){
        if(!validReturnTarget(freshTarget.data(),manager,schoolId,sourceId,
             fingerprint,managerCanManageSource,schoolIdOf))deny(HttpsError)
        return 'reused'
      }
      if(!freshSource.exists||!isSameTime(sourceSnap.updateTime,freshSource.updateTime)||
          !managerCanManageSource(manager,freshSource.data()||{}))deny(HttpsError)
      tx.create(targetRef,next)
      return 'created'
    })
    return {ok:true,listeningId:targetId,reused:operation==='reused'}
  }
}
module.exports={targetMediaPath,cloneAsPrivate,checkedMeta,
  createDuplicatePrivateListeningSecure}
