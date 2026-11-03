'use strict'
const { requireProtectedVault } = require('./p0bVaultSecurity')

// STEP 998: Authorized, token-free media chunks for assigned Listening/Mock.
// This service does not issue signed URLs or read user-provided object paths.
// Keep this backend OFF production until the client migration, revoked download
// tokens, legacy/external assets and positive/negative tests are complete.
const CHUNK_SIZE = 2 * 1024 * 1024
const AUDIO_LIMIT = 30 * 1024 * 1024
const MAP_LIMIT = 8 * 1024 * 1024

function cleanId(value, name, HttpsError) {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
      value.includes('/') || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    throw new HttpsError('invalid-argument', `${name} is invalid.`)
  }
  return value
}

function parseRequest(data, HttpsError) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Media request must be an object.')
  }
  const contentId = cleanId(data.listeningId, 'Listening ID', HttpsError)
  const asset = data.asset
  if (asset !== 'audio' && asset !== 'map') {
    throw new HttpsError('invalid-argument', 'Unknown media asset.')
  }
  const mockTestId = data.mockTestId === undefined || data.mockTestId === ''
    ? '' : cleanId(data.mockTestId, 'Mock ID', HttpsError)
  const questionId = asset === 'map'
    ? cleanId(data.questionId, 'Question ID', HttpsError)
    : ''
  const partId = data.partId === undefined || data.partId === ''
    ? '' : cleanId(data.partId, 'Part ID', HttpsError)
  const offset = data.offset === undefined ? 0 : data.offset
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      offset % CHUNK_SIZE !== 0 || offset >= AUDIO_LIMIT) {
    throw new HttpsError('invalid-argument', 'Invalid media offset.')
  }
  // Do not let clients request an arbitrary storagePath/URL or actor identity.
  const allowed = new Set(['listeningId', 'asset', 'mockTestId', 'questionId', 'partId', 'offset'])
  if (Object.keys(data).some(key => !allowed.has(key))) {
    throw new HttpsError('invalid-argument', 'Unexpected media request parameter.')
  }
  return { contentId, asset, mockTestId, questionId, partId, offset }
}

function sourceMediaPath(source, data, HttpsError) {
  if (data.asset === 'audio') return source.audioStoragePath || ''
  const paths = new Set()
  const collect = (q, partId) => {
    if (!q || q.id !== data.questionId ||
        (data.partId && partId !== data.partId)) return
    if (q.type !== 'map') return
    if (typeof q.mapImageStoragePath === 'string' && q.mapImageStoragePath) {
      paths.add(q.mapImageStoragePath)
    }
  }
  for (const part of Array.isArray(source.parts) ? source.parts : []) {
    for (const question of Array.isArray(part.questions) ? part.questions : []) {
      collect(question, part.id)
    }
  }
  if (!data.partId) {
    for (const question of Array.isArray(source.questions) ? source.questions : []) {
      collect(question, '')
    }
  }
  if (paths.size > 1) {
    throw new HttpsError('failed-precondition', 'Ambiguous Listening map source.')
  }
  return [...paths][0] || ''
}

function verifiedStoragePath(storagePath, asset, HttpsError, contentId = '') {
  if (typeof storagePath !== 'string') {
    throw new HttpsError('failed-precondition', 'Invalid Listening media path.')
  }
  const pieces = storagePath.split('/')
  if (pieces.some(x => !x || x === '.' || x === '..' || /[\u0000-\u001f]/.test(x))) {
    throw new HttpsError('failed-precondition', 'Invalid stored Listening media.')
  }
  if (pieces[0] === 'private-listening-media') {
    if (pieces.length !== 5 || pieces[2] !== contentId || pieces[3] !== asset ||
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(pieces[4])) {
      throw new HttpsError('failed-precondition', 'Private media identity mismatch.')
    }
    return {path:storagePath, ownerId:pieces[1], isPrivate:true}
  }
  const prefix = asset === 'audio' ? 'listening-audios' : 'listening-map-images'
  if (pieces.length !== 3 || pieces[0] !== prefix) {
    throw new HttpsError('failed-precondition', 'Unexpected legacy media path.')
  }
  return {path:storagePath, ownerId:pieces[1], isPrivate:false}
}

function sourcePermittedForMock(mock, source, schoolIdOf) {
  if (schoolIdOf(mock) !== schoolIdOf(source)) return false
  if ((source.visibility || source.libraryVisibility) === 'school') return true
  const owner = mock.createdBy || mock.teacherId || ''
  if (!owner) return false
  return owner === source.createdBy || owner === source.teacherId ||
    (Array.isArray(source.teacherIds) && source.teacherIds.includes(owner))
}

function createPrivateListeningMediaService(deps) {
  const { db, bucket, getVaultBucket, HttpsError, requireStudent, requireAssignmentManager,
    requireAvailableStudentSource, requireAssignedMock, assertMockResourceEnabled,
    schoolIdOf, managerCanManageSource } = deps

  return async function getPrivateListeningMediaChunk(request) {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Please sign in.')
    const data = parseRequest(request.data || {}, HttpsError)
    const sourceSnap = await db.doc(`listenings/${data.contentId}`).get()
    if (!sourceSnap.exists) throw new HttpsError('not-found', 'Listening was not found.')
    const source = { ...sourceSnap.data(), id: sourceSnap.id }
    if (source.deleted === true || source.deleteInProgress === true) {
      throw new HttpsError('permission-denied', 'Listening is no longer available.')
    }

    // Read the LIVE profile; never use the client-provided role or school.
    const profileSnap = await db.doc(`users/${request.auth.uid}`).get()
    if (!profileSnap.exists) throw new HttpsError('permission-denied', 'Unknown user.')
    const profile = profileSnap.data() || {}

    if (profile.role === 'student') {
      const student = await requireStudent(request)
      if (schoolIdOf(source) !== student.schoolId) {
        throw new HttpsError('permission-denied', 'This media belongs to another school.')
      }
      if (data.mockTestId) {
        const mock = await requireAssignedMock(data.mockTestId, student)
        assertMockResourceEnabled(mock, 'listening', data.contentId)
        if (!sourcePermittedForMock(mock, source, schoolIdOf)) {
          // Preserve the verified platform-admin mock-authoring exception in
          // Firestore rules. Read the LIVE owner profile; never trust an ID
          // alone as proof of platform-admin privilege.
          const ownerId = mock.createdBy || mock.teacherId || ''
          const ownerSnap = ownerId && !ownerId.includes('/')
            ? await db.doc(`users/${ownerId}`).get()
            : null
          const owner = ownerSnap?.exists ? (ownerSnap.data() || {}) : {}
          if (owner.role !== 'admin' || owner.status !== 'approved' ||
              owner.deleted === true || owner.archived === true) {
            throw new HttpsError('permission-denied', 'Mock source is not authorized.')
          }
        }
      } else {
        await requireAvailableStudentSource({
          student, source, contentType:'listening',
          contentId:data.contentId, sourceCollection:'listenings'
        })
      }
    } else if (profile.role === 'teacher' || profile.role === 'admin') {
      const manager = await requireAssignmentManager(request)
      // A shared school-library metadata record does not by itself authorize
      // access to assigned-only media. The teacher must have current rights to
      // manage the underlying Listening; platform admins remain supported.
      if (!managerCanManageSource(manager, source)) {
        throw new HttpsError('permission-denied', 'Listening media is not available to you.')
      }
    } else {
      throw new HttpsError('permission-denied', 'This account cannot open Listening media.')
    }

    const selected = sourceMediaPath(source, data, HttpsError)
    const { path, ownerId, isPrivate } = verifiedStoragePath(
      selected, data.asset, HttpsError, data.contentId)
    const sourceOwner = source.createdBy || source.teacherId || ''
    if (!sourceOwner || sourceOwner !== ownerId) {
      throw new HttpsError('permission-denied','Listening media owner mismatch.')
    }
    // Legacy reads remain on the historical bucket. Only private paths require
    // the IAM-isolated bucket, whose policy is validated on each request.
    const selectedBucket = isPrivate
      ? await requireProtectedVault(getVaultBucket, bucket, HttpsError)
      : bucket
    const file = selectedBucket.file(path)
    let meta
    try {
      ;[meta] = await file.getMetadata()
    } catch (error) {
      if (Number(error.code) === 404) {
        throw new HttpsError('not-found', 'Listening media file was not found.')
      }
      throw error
    }
    const custom = meta.metadata || {}
    const mime = String(meta.contentType || '')
    const size = Number(meta.size)
    const cap = data.asset === 'audio' ? AUDIO_LIMIT : MAP_LIMIT
    const permittedType = data.asset === 'audio'
      ? mime.startsWith('audio/')
      : ['image/jpeg','image/png','image/webp'].includes(mime)
    // New uploads must be finalized and bound to their original Listening.
    // Historical assets without these fields remain readable until migration.
    const privateUploadInvalid = isPrivate
      ? custom.privateMediaV1 !== 'ready_private_v1' ||
        custom.listeningId !== data.contentId ||
        Boolean(custom.firebaseStorageDownloadTokens)
      : (custom.privateMediaV1 && custom.privateMediaV1 !== 'ready_private_v1') ||
        (custom.listeningId && custom.listeningId !== data.contentId)
    if (!permittedType || !Number.isSafeInteger(size) || size <= 0 || size > cap ||
        custom.schoolId !== schoolIdOf(source) || custom.createdBy !== ownerId ||
        privateUploadInvalid) {
      throw new HttpsError('permission-denied', 'Stored Listening media failed its integrity check.')
    }
    if (data.offset >= size) {
      throw new HttpsError('invalid-argument', 'Media offset exceeds the file length.')
    }
    const end = Math.min(data.offset + CHUNK_SIZE, size) - 1
    const [bytes] = await file.download({ start:data.offset, end })
    if (!Buffer.isBuffer(bytes) || bytes.length !== end - data.offset + 1) {
      throw new HttpsError('internal', 'Media chunk was incomplete.')
    }
    return {
      asset:data.asset, listeningId:data.contentId,
      mime, totalBytes:size, offset:data.offset,
      chunkBytes:bytes.length, chunkSize:CHUNK_SIZE,
      base64:bytes.toString('base64')
    }
  }
}

module.exports = {
  CHUNK_SIZE, parseRequest, sourceMediaPath, verifiedStoragePath,
  sourcePermittedForMock, createPrivateListeningMediaService
}
