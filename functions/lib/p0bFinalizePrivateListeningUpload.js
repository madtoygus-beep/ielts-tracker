'use strict'
const { createHash } = require('node:crypto')
const { requireProtectedVault } = require('./p0bVaultSecurity')

// STEP1000B: Privileged completion for NEW browser-uploaded Listening media.
// Upload URLs are NEVER returned to clients. This is deliberately limited to
// pending_private_v1 uploads so existing student assets cannot be invalidated.
const PREFIX = Object.freeze({audio:'listening-audios',map:'listening-map-images'})
const CAP = Object.freeze({audio:30*1024*1024,map:8*1024*1024})

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !value.includes('/') &&
    !/[\u0000-\u001f]/.test(value)
}

function validateRequest(raw, uid, HttpsError) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(k=>!['path','asset','listeningId'].includes(k))) {
    throw new HttpsError('invalid-argument','Invalid Listening upload confirmation.')
  }
  if (!Object.hasOwn(PREFIX,raw.asset) || !validId(raw.listeningId) ||
      raw.listeningId === '.' || raw.listeningId === '..') {
    throw new HttpsError('invalid-argument','Invalid Listening upload identity.')
  }
  if (typeof raw.path !== 'string' || raw.path.length > 700) {
    throw new HttpsError('invalid-argument','Invalid Listening file path.')
  }
  const parts = raw.path.split('/')
  if (parts.length !== 3 || parts[0] !== PREFIX[raw.asset] ||
      parts[1] !== uid || !validId(parts[2]) ||
      parts[2] === '.' || parts[2] === '..') {
    throw new HttpsError('permission-denied','This media upload does not belong to you.')
  }
  return {path:raw.path,asset:raw.asset,listeningId:raw.listeningId}
}

function inspectMetadata(meta, data, uid, schoolId, HttpsError) {
  const custom = meta?.metadata || {}
  const size = Number(meta?.size)
  const mime = String(meta?.contentType || '')
  const typeOk = data.asset === 'audio'
    ? mime.startsWith('audio/')
    : ['image/png','image/jpeg','image/webp'].includes(mime)
  if (custom.createdBy !== uid || custom.schoolId !== schoolId ||
      custom.listeningId !== data.listeningId ||
      !['pending_private_v1','ready_private_v1'].includes(custom.privateMediaV1) ||
      !typeOk || !Number.isSafeInteger(size) || size < 1 || size > CAP[data.asset]) {
    throw new HttpsError('permission-denied','This media upload failed verification.')
  }
  return custom
}

// The destination is stable per unique staging path. A concurrent request
// cannot mint another UUID/another copy for the same uploaded object.
function stablePrivatePath(data,uid) {
  const hash = createHash('sha256').update(uid+'\x1f'+data.path+'\x1f'+data.listeningId+'\x1f'+data.asset).digest('hex')
  const unique = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`
  return `private-listening-media/${uid}/${data.listeningId}/${data.asset}/${unique}`
}

async function maybeMeta(file) {
  try { const [m] = await file.getMetadata(); return m }
  catch(e) { if(Number(e?.code)===404)return null; throw e }
}
function comparePrivate(meta,first,data,uid,schoolId,vaultName,pathHash,HttpsError) {
  if(!meta || meta.bucket!==vaultName ||
      meta.metadata?.createdBy!==uid ||
      meta.metadata?.schoolId!==schoolId ||
      meta.metadata?.listeningId!==data.listeningId ||
      meta.metadata?.privateMediaV1!=='ready_private_v1' ||
      meta.metadata?.stagingPathSha256!==pathHash ||
      Boolean(meta.metadata?.firebaseStorageDownloadTokens)){
    throw new HttpsError('failed-precondition','Private media integrity verification failed.')
  }
  if(first && (
     String(meta.size)!==String(first.size) ||
     meta.metadata?.stagingGeneration!==String(first.generation) ||
     (first.crc32c && meta.crc32c && first.crc32c!==meta.crc32c))) {
    throw new HttpsError('failed-precondition','Private media source verification failed.')
  }
  return meta
}
function createFinalizePrivateListeningUpload({bucket,getVaultBucket,HttpsError,requireAssignmentManager,schoolIdOf}) {
  return async request => {
    const manager=await requireAssignmentManager(request)
    const data=validateRequest(request.data,manager.uid,HttpsError)
    const schoolId=schoolIdOf(manager.profile)
    const vault=await requireProtectedVault(getVaultBucket,bucket,HttpsError)
    const stage=bucket.file(data.path)
    const destPath=stablePrivatePath(data,manager.uid)
    const dest=vault.file(destPath)
    const pathHash=createHash('sha256').update(data.path).digest('hex')
    let initial=await maybeMeta(stage)
    let existing=await maybeMeta(dest)
    if(!initial){
      // Idempotent successful retry when staging has already been removed.
      comparePrivate(existing,null,data,manager.uid,schoolId,vault.name,pathHash,HttpsError)
      return {ok:true,asset:data.asset,listeningId:data.listeningId,storagePath:destPath}
    }
    const original=inspectMetadata(initial,data,manager.uid,schoolId,HttpsError)
    if(original.privateMediaV1!=='pending_private_v1'){
      throw new HttpsError('failed-precondition','Upload already finalized or invalid.')
    }
    let createdByThisCall=false
    let ownedGeneration=null
    if(!existing){
      // Pin source generation and metageneration; never depend on metadata token
      // clearing (Firebase Storage Emulator retains tokens in a separate list).
      const again=await maybeMeta(stage)
      if(!again || String(again.generation)!==String(initial.generation) ||
          String(again.metageneration)!==String(initial.metageneration)){
        throw new HttpsError('failed-precondition','Staging object changed while finalizing.')
      }
      const metadata={
        createdBy:manager.uid,schoolId,listeningId:data.listeningId,
        privateMediaV1:'ready_private_v1',
        stagingPathSha256:pathHash,stagingGeneration:String(initial.generation)
      }
      try{
        await bucket.file(data.path,{generation:initial.generation}).copy(dest,{
          preconditionOpts:{ifGenerationMatch:0},
          contentType:initial.contentType,
          cacheControl:'private, no-store',
          metadata
        })
        createdByThisCall=true
      }catch(e){
        // Another concurrent caller may have won create-only; accept only a
        // destination fully verified against the *same* pinned staging bytes.
        if(Number(e?.code)!==412)throw e
      }
      existing=await maybeMeta(dest)
    }
    try{
      if(createdByThisCall)ownedGeneration=existing?.generation
      const checked=comparePrivate(existing,initial,data,manager.uid,schoolId,
        vault.name,pathHash,HttpsError)
      ownedGeneration=checked.generation
      try{
        await bucket.file(data.path,{generation:initial.generation}).delete()
      }catch(e){
        if(Number(e?.code)!==404)throw e
      }
      if(await maybeMeta(stage)){
        throw new HttpsError('failed-precondition','Staging media still exists after cleanup.')
      }
      return {ok:true,asset:data.asset,listeningId:data.listeningId,storagePath:destPath}
    }catch(e){
      // If *this invocation* created the private copy and staging still exists,
      // compensate with generation-pinned deletion; never publish an orphan.
      // A crash between copy/delete is recoverable by a same-path retry.
      let stageExists=true
      try {stageExists=Boolean(await maybeMeta(stage))} catch(_){/* fail closed */}
      if(createdByThisCall && stageExists && ownedGeneration){
        try{await vault.file(destPath,{generation:ownedGeneration}).delete()}
        catch(_){/* no success returned; reconciliation sweep required */}
      }
      throw e
    }
  }
}
module.exports={validateRequest,inspectMetadata,stablePrivatePath,createFinalizePrivateListeningUpload}
