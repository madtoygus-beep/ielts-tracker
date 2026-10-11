'use strict'

// P4C: Independent, server-managed Self-Study Master Library.
// Only approved platform Self-Study Managers may invoke these callables.
// No answer-bearing document is ever returned by a list operation or exposed
// through client Firestore / Storage rules. Learner entitlement is P4D.

const { createHash } = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { getFirestore, FieldPath, FieldValue } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')

const SOURCE_SCHOOL_ID = 'maxima'
const PLATFORM_SCHOOL_ID = '__platform__'
const MASTER_COLLECTION = 'masterContent'
const STORAGE_BUCKET = 'maxima-tracker.firebasestorage.app'
const PAGE_LIMIT = 40
const MAX_PAGE_LIMIT = 80
const MASTER_SCHEMA_VERSION = 1
const PRIVATE_IDENTITY_FIELDS = new Set([
  'uid', 'studentId', 'studentIds', 'studentEmail', 'studentName',
  'recipientIds', 'assignedTo', 'assignedStudents', 'teacherId', 'teacherIds',
  'schoolId', 'createdBy', 'updatedBy', 'ownerId', 'classId', 'classIds',
  'submissions', 'scores', 'reviewerId', 'authUid'
])

const SOURCE_CONFIG = Object.freeze({
  reading: {
    collection: 'readings',
    fields: ['title', 'module', 'contentType', 'passageMode', 'passage', 'paragraphs', 'headings', 'questions', 'timeLimit']
  },
  listening: {
    collection: 'listenings',
    fields: ['title', 'module', 'contentType', 'listeningType', 'instructions', 'audioUrl', 'audioFileName', 'audioStoragePath', 'timeLimit', 'parts', 'questions']
  },
  writing: {
    collection: 'writingHomeworks',
    fields: ['title', 'module', 'contentType', 'writingMode', 'timeLimit', 'task1Enabled', 'task2Enabled', 'task1', 'task2']
  },
  vocabulary: {
    collection: 'vocabularyTests',
    fields: ['title', 'module', 'contentType', 'instructions', 'timeLimit', 'questions', 'questionCount', 'hasWorkbookTasks', 'matchingShuffle']
  },
  mock: {
    collection: 'mockTests',
    fields: [
      'title', 'module', 'contentType', 'mockType', 'enabledSections',
      'fullMockListeningMode', 'miniSectionCounts', 'listeningId',
      'listeningIds', 'readingIds', 'writingId', 'writingMode',
      'sectionTimeLimits', 'totalTimeMinutes', 'mode'
    ]
  }
})

function fail(code, message) {
  throw new HttpsError(code, message)
}

function checkId(value, label = 'Document ID') {
  if (typeof value !== 'string') fail('invalid-argument', `${label} is required.`)
  const id = value.trim()
  if (!id || id.includes('/') || Buffer.byteLength(id, 'utf8') > 200) {
    fail('invalid-argument', `Invalid ${label.toLowerCase()}.`)
  }
  return id
}

function checkType(value) {
  if (typeof value !== 'string' || !Object.hasOwn(SOURCE_CONFIG, value)) {
    fail('invalid-argument', 'Unsupported content type.')
  }
  return value
}

function cleanString(value, max = 160) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function safePageSize(value) {
  const size = Number(value)
  return Number.isInteger(size) && size >= 1
    ? Math.min(size, MAX_PAGE_LIMIT)
    : PAGE_LIMIT
}

function sourceSchoolId(source) {
  return source?.schoolId || SOURCE_SCHOOL_ID // Legacy Maxima fallback.
}

function isEligibleMaximaSource(source) {
  return source && sourceSchoolId(source) === SOURCE_SCHOOL_ID &&
    (source.visibility ?? source.libraryVisibility) === 'school' &&
    source.archived !== true
}

function snapshotVersion(snapshot) {
  if (snapshot.updateTime && typeof snapshot.updateTime.toDate === 'function') {
    return snapshot.updateTime.toDate().toISOString()
  }
  return cleanString(snapshot.data()?.updatedAt, 100) || 'unknown'
}

// Only content fields are copied. School, teacher, student, assignment and
// submission identity/PII never enter the independent master document.
function copyPlain(value, depth = 0) {
  if (depth > 30) fail('failed-precondition', 'Content nesting is too deep to copy safely.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('failed-precondition', 'Invalid numeric content value.')
    return value
  }
  if (Array.isArray(value)) return value.map(item => copyPlain(item, depth + 1))
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString()
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || PRIVATE_IDENTITY_FIELDS.has(key)) continue
      if (child !== undefined) result[key] = copyPlain(child, depth + 1)
    }
    return result
  }
  fail('failed-precondition', 'Unsupported content value type.')
}

function copyTeachingFields(source, type) {
  const output = {}
  for (const field of SOURCE_CONFIG[type].fields) {
    if (Object.hasOwn(source, field) && source[field] !== undefined) {
      output[field] = copyPlain(source[field])
    }
  }
  return output
}

function docHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 40)
}

function makeMasterId(value) {
  return `mc_${docHash(value)}`
}

function uniqueIds(raw) {
  if (!Array.isArray(raw)) return []
  const ids = raw.filter(value => typeof value === 'string' && value.trim()).map(value => checkId(value, 'Linked content ID'))
  return [...new Set(ids)]
}

function mockSourceLinks(source) {
  const readings = uniqueIds(source.readingIds)
  const listenings = uniqueIds(source.listeningIds)
  if (!readings.length && source.readingId) readings.push(checkId(source.readingId, 'Reading ID'))
  if (!listenings.length && source.listeningId) listenings.push(checkId(source.listeningId, 'Listening ID'))
  const writing = source.writingId ? [checkId(source.writingId, 'Writing ID')] : []
  return [
    ...readings.map(id => ({ type: 'reading', id })),
    ...listenings.map(id => ({ type: 'listening', id })),
    ...writing.map(id => ({ type: 'writing', id }))
  ]
}

function infoForSource(snapshot, type) {
  const source = snapshot.data() || {}
  const questions = Array.isArray(source.questions) ? source.questions.length : 0
  const mediaExternal = type === 'listening' && Boolean(source.audioUrl) && !source.audioStoragePath
  return {
    id: snapshot.id,
    contentType: type,
    title: cleanString(source.title, 180) || 'Untitled',
    contentMode: cleanString(source.contentType, 60),
    version: snapshotVersion(snapshot),
    blocks: questions,
    archived: source.archived === true,
    mediaNeedsUpload: mediaExternal,
    linkedParts: type === 'mock' ? mockSourceLinks(source).length : 0
  }
}

function infoForMaster(snapshot) {
  const item = snapshot.data() || {}
  return {
    id: snapshot.id,
    title: cleanString(item.title, 180),
    description: cleanString(item.description, 400),
    contentType: item.contentType || '',
    contentMode: item.contentMode || '',
    status: item.status || 'draft',
    sourceType: item.sourceType || '',
    sourceSchoolId: item.sourceSchoolId || '',
    sourceContentId: item.sourceContentId || '',
    sourceVersion: item.sourceVersion || '',
    linkedFromMasterMockId: item.linkedFromMasterMockId || null,
    linkedMasterContentIds: Array.isArray(item.linkedMasterContentIds) ? item.linkedMasterContentIds : [],
    assetCount: Number(item.assetCount) || 0,
    blockCount: Number(item.blockCount) || 0,
    schemaVersion: Number(item.schemaVersion) || 0
  }
}

async function requireManager(request) {
  if (!request.auth?.uid) fail('unauthenticated', 'Sign in to your manager account.')
  const uid = request.auth.uid
  const snap = await getFirestore().doc(`users/${uid}`).get()
  const profile = snap.exists ? (snap.data() || {}) : null
  if (!profile || profile.role !== 'selfStudyManager' ||
      profile.accountType !== 'platform' || profile.scope !== 'selfStudy' ||
      profile.schoolId !== PLATFORM_SCHOOL_ID ||
      profile.status !== 'approved' || profile.deleted === true) {
    fail('permission-denied', 'An active Self-Study Manager account is required.')
  }
  return uid
}

async function loadSource(type, id) {
  const snapshot = await getFirestore().doc(`${SOURCE_CONFIG[type].collection}/${id}`).get()
  if (!snapshot.exists) fail('not-found', `The ${type} content no longer exists.`)
  if (!isEligibleMaximaSource(snapshot.data())) {
    fail('permission-denied', `The ${type} content is not an active shared Maxima library item.`)
  }
  return snapshot
}

// Media must be first-party Firebase Storage objects. Download-token URLs and
// external URLs are not retained or copied; otherwise imports would still be
// live-linked to Maxima or a third-party host. Source owner path is checked.
function mappedMediaPath(path, kind, source, masterId, media) {
  const expectedPrefix = kind === 'audio' ? 'listening-audios/' : 'listening-map-images/'
  const ownerId = cleanString(source.createdBy || source.teacherId, 200)
  const expectedOwnerPrefix = `${expectedPrefix}${ownerId}/`
  if (!ownerId || typeof path !== 'string' || !path.startsWith(expectedOwnerPrefix)) {
    fail('failed-precondition', `${kind} must have a valid source-owned Firebase Storage path.`)
  }
  const fileName = path.slice(expectedOwnerPrefix.length)
  if (!fileName || fileName.includes('/') || fileName.includes('..') || fileName.length > 220) {
    fail('failed-precondition', `Invalid ${kind} source file name.`)
  }
  if (media.has(path)) return media.get(path).dest
  const ext = fileName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || (kind === 'audio' ? 'bin' : 'png')
  const dest = `self-study-master/${masterId}/assets/${kind}-${docHash(path)}.${ext}`
  media.set(path, { source: path, dest, kind })
  return dest
}

function remapNestedMapImages(node, source, masterId, media, depth = 0) {
  if (depth > 30) fail('failed-precondition', 'Map image data is too deeply nested.')
  if (Array.isArray(node)) {
    node.forEach(child => remapNestedMapImages(child, source, masterId, media, depth + 1))
    return
  }
  if (!node || typeof node !== 'object') return
  const possibleImageKeys = ['mapImage', 'mapImageUrl', 'image', 'imageUrl']
  const hasImage = possibleImageKeys.some(key => typeof node[key] === 'string' && node[key].trim())
  const path = node.mapImageStoragePath
  if (hasImage || path) {
    if (!path) {
      fail('failed-precondition', 'A Listening map image uses an external URL. Upload it to Maxima Storage before importing.')
    }
    node.mapImageStoragePath = mappedMediaPath(path, 'map', source, masterId, media)
    // DoListening supports multiple legacy image-property names. Strip every
    // original URL so no fallback can still fetch the institution asset.
    possibleImageKeys.forEach(key => { if (Object.hasOwn(node, key)) node[key] = '' })
  }
  for (const child of Object.values(node)) remapNestedMapImages(child, source, masterId, media, depth + 1)
}

function buildMasterContent(source, type, masterId) {
  const content = copyTeachingFields(source, type)
  const media = new Map()
  if (type === 'writing' && content.task1?.image) {
    if (typeof content.task1.image !== 'string' ||
        !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(content.task1.image)) {
      fail('failed-precondition', 'Writing Task 1 image is not an embedded image. Upload it in Maxima before importing.')
    }
  }
  if (type === 'listening') {
    if (content.audioUrl && !content.audioStoragePath) {
      fail('failed-precondition', 'Audio uses an external URL. Upload the audio file to Maxima Storage before importing.')
    }
    if (content.audioStoragePath) {
      content.audioStoragePath = mappedMediaPath(content.audioStoragePath, 'audio', source, masterId, media)
      content.audioUrl = '' // P4D issues signed URLs only after entitlement.
    }
    remapNestedMapImages(content.parts, source, masterId, media)
    remapNestedMapImages(content.questions, source, masterId, media)
  }
  return { content, media: [...media.values()] }
}

function contentBlockCount(content, type) {
  if (type === 'mock') return (content.readingIds?.length || 0) + (content.listeningIds?.length || 0) + (content.writingId ? 1 : 0)
  if (Array.isArray(content.questions)) return content.questions.length
  if (type === 'writing') return Number(Boolean(content.task1Enabled)) + Number(Boolean(content.task2Enabled))
  return 0
}

function masterPayload(plan, managerUid, rootId) {
  const source = plan.snapshot.data() || {}
  const copy = buildMasterContent(source, plan.type, plan.id)
  plan.assets = copy.media
  if (plan.type === 'mock') {
    const childMap = new Map(plan.children.map(child => [`${child.type}:${child.snapshot.id}`, child.id]))
    const mapLinks = (type, ids) => ids.map(id => {
      const mapped = childMap.get(`${type}:${id}`)
      if (!mapped) fail('failed-precondition', `Missing independent ${type} resource for mock.`)
      return mapped
    })
    copy.content.readingIds = mapLinks('reading', uniqueIds(source.readingIds).length ? uniqueIds(source.readingIds) : (source.readingId ? [source.readingId] : []))
    copy.content.listeningIds = mapLinks('listening', uniqueIds(source.listeningIds).length ? uniqueIds(source.listeningIds) : (source.listeningId ? [source.listeningId] : []))
    copy.content.readingId = copy.content.readingIds[0] || ''
    copy.content.listeningId = copy.content.listeningIds[0] || ''
    copy.content.writingId = source.writingId ? mapLinks('writing', [source.writingId])[0] : ''
  }
  const linkedMasterContentIds = plan.children?.map(child => child.id) || []
  return {
    schemaVersion: MASTER_SCHEMA_VERSION,
    title: cleanString(source.title, 180) || 'Untitled',
    description: '',
    contentType: plan.type,
    contentMode: cleanString(source.contentType, 60),
    status: 'draft',
    sourceType: 'institution',
    sourceSchoolId: SOURCE_SCHOOL_ID,
    sourceCollection: SOURCE_CONFIG[plan.type].collection,
    sourceContentId: plan.snapshot.id,
    sourceVersion: snapshotVersion(plan.snapshot),
    linkedFromMasterMockId: plan.isChild ? rootId : null,
    linkedMasterContentIds,
    assetCount: copy.media.length,
    assetManifest: copy.media.map(asset => ({ kind: asset.kind, storagePath: asset.dest })),
    blockCount: contentBlockCount(copy.content, plan.type),
    content: copy.content, // Answer keys remain *server-only*.
    createdBy: managerUid,
    updatedBy: managerUid,
    importedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }
}

async function copyIndependentMedia(plans) {
  const bucket = getStorage().bucket(STORAGE_BUCKET)
  const tasks = []
  let combinedBytes = 0

  // Preflight all assets before writing anything. This avoids partial copies
  // when a later linked Mock resource is missing or unexpectedly large.
  for (const plan of plans) {
    for (const asset of plan.assets || []) {
      const sourceFile = bucket.file(asset.source)
      const targetFile = bucket.file(asset.dest)
      const [metadata] = await sourceFile.getMetadata().catch(() => {
        fail('failed-precondition', `Media file is missing: ${asset.kind} (${plan.type}).`)
      })
      const bytes = Number(metadata.size) || 0
      const maxBytes = asset.kind === 'audio' ? 30 * 1024 * 1024 : 8 * 1024 * 1024
      const mime = String(metadata.contentType || '').toLowerCase()
      const goodMime = asset.kind === 'audio' ? mime.startsWith('audio/') : mime.startsWith('image/')
      if (bytes > maxBytes || !goodMime) {
        fail('failed-precondition', `Unsupported ${asset.kind} content size or type in Maxima Storage.`)
      }
      combinedBytes += bytes
      tasks.push({ asset, sourceFile, targetFile, metadata })
    }
  }
  if (combinedBytes > 150 * 1024 * 1024) {
    fail('failed-precondition', 'The linked media exceeds 150 MB. Split the Mock before importing.')
  }

  // Transfer without copying Firebase download-token metadata. New Storage
  // objects are server-only; client rules do not allow direct reading.
  for (const { asset, sourceFile, targetFile, metadata } of tasks) {
    const [exists] = await targetFile.exists()
    if (exists) continue // Idempotent retry for the same source version.
    try {
      await pipeline(
        sourceFile.createReadStream(),
        targetFile.createWriteStream({
          resumable: false,
          metadata: {
            contentType: metadata.contentType,
            cacheControl: 'private, no-store',
            metadata: { importedForSelfStudy: 'true' }
          }
        })
      )
    } catch (error) {
      console.error('Master media copy failed:', { source: asset.source, dest: asset.dest, message: error?.message })
      fail('failed-precondition', 'Media copy failed. The original was not changed. Check that all source media files are available.')
    }
  }
}

async function planImport(type, contentId) {
  const rootSnapshot = await loadSource(type, contentId)
  const refs = type === 'mock' ? mockSourceLinks(rootSnapshot.data() || {}) : []
  if (type === 'mock' && refs.length === 0) {
    fail('failed-precondition', 'Mock has no linked content. Add shared Maxima resources before importing.')
  }
  if (refs.length > 15) fail('failed-precondition', 'Mock has too many linked resources (maximum 15).')
  const childSnapshots = await Promise.all(refs.map(ref => loadSource(ref.type, ref.id)))
  const versions = [
    `${type}:${contentId}:${snapshotVersion(rootSnapshot)}`,
    ...refs.map((ref, index) => `${ref.type}:${ref.id}:${snapshotVersion(childSnapshots[index])}`)
  ]
  const rootId = makeMasterId(`p4c-v1|${versions.join('|')}`)
  const children = refs.map((ref, index) => ({
    type: ref.type,
    snapshot: childSnapshots[index],
    id: makeMasterId(`p4c-mock-child-v1|${rootId}|${ref.type}|${ref.id}`),
    children: [],
    isChild: true,
    assets: []
  }))
  const root = { type, snapshot: rootSnapshot, id: rootId, children, isChild: false, assets: [] }
  return [root, ...children]
}

exports.listMaximaSourceContent = onCall({ invoker: 'public' }, async request => {
  await requireManager(request)
  const type = checkType(request.data?.contentType)
  const limit = safePageSize(request.data?.limit)
  const cursor = request.data?.cursor ? checkId(request.data.cursor, 'Cursor') : null
  let query = getFirestore().collection(SOURCE_CONFIG[type].collection)
    .orderBy(FieldPath.documentId())
  if (cursor) query = query.startAfter(cursor)
  const snapshot = await query.limit(limit + 1).get()
  const current = snapshot.docs.slice(0, limit)
  return {
    ok: true,
    contentType: type,
    items: current.filter(doc => isEligibleMaximaSource(doc.data())).map(doc => infoForSource(doc, type)),
    nextCursor: snapshot.docs.length > limit && current.length ? current[current.length - 1].id : null
  }
})

exports.listSelfStudyMasterContent = onCall({ invoker: 'public' }, async request => {
  await requireManager(request)
  const limit = safePageSize(request.data?.limit)
  const cursor = request.data?.cursor ? checkId(request.data.cursor, 'Cursor') : null
  let query = getFirestore().collection(MASTER_COLLECTION).orderBy(FieldPath.documentId())
  if (cursor) query = query.startAfter(cursor)
  const snapshot = await query.limit(limit + 1).get()
  const current = snapshot.docs.slice(0, limit)
  return {
    ok: true,
    items: current.map(infoForMaster),
    nextCursor: snapshot.docs.length > limit && current.length ? current[current.length - 1].id : null
  }
})

exports.importMaximaToMasterContent = onCall({ invoker: 'public', timeoutSeconds: 300, memory: '512MiB' }, async request => {
  const uid = await requireManager(request)
  const type = checkType(request.data?.contentType)
  const contentId = checkId(request.data?.sourceContentId, 'Source content ID')
  const plans = await planImport(type, contentId)
  const rootId = plans[0].id
  const db = getFirestore()
  const existing = await db.doc(`${MASTER_COLLECTION}/${rootId}`).get()
  if (existing.exists) {
    return { ok: true, masterId: rootId, alreadyImported: true, createdCount: 0, assetCount: Number(existing.data()?.assetCount) || 0 }
  }

  const payloads = plans.map(plan => masterPayload(plan, uid, rootId))
  await copyIndependentMedia(plans)
  await requireManager(request) // Recheck approval after potentially lengthy media transfer.

  const batch = db.batch()
  plans.forEach((plan, index) => batch.create(db.doc(`${MASTER_COLLECTION}/${plan.id}`), payloads[index]))
  try {
    await batch.commit()
  } catch (error) {
    const after = await db.doc(`${MASTER_COLLECTION}/${rootId}`).get()
    if (after.exists) {
      return { ok: true, masterId: rootId, alreadyImported: true, createdCount: 0, assetCount: Number(after.data()?.assetCount) || 0 }
    }
    console.error('P4C master import failed:', { type, sourceId: contentId, message: error?.message })
    fail('failed-precondition', 'Could not save the independent master copy. The Maxima source was not changed.')
  }

  return {
    ok: true,
    masterId: rootId,
    alreadyImported: false,
    createdCount: plans.length,
    assetCount: payloads.reduce((total, item) => total + item.assetCount, 0)
  }
})

exports.updateSelfStudyMasterContent = onCall({ invoker: 'public' }, async request => {
  const uid = await requireManager(request)
  const masterId = checkId(request.data?.masterId, 'Master ID')
  const changes = request.data?.changes
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    fail('invalid-argument', 'Changes are required.')
  }
  const keys = Object.keys(changes)
  if (!keys.length || keys.some(key => !['title', 'description', 'status'].includes(key))) {
    fail('invalid-argument', 'Only title, description and draft/archive status may be changed in P4C.')
  }
  const db = getFirestore()
  const ref = db.doc(`${MASTER_COLLECTION}/${masterId}`)
  const snap = await ref.get()
  if (!snap.exists) fail('not-found', 'Master content was not found.')
  const original = snap.data() || {}
  if (original.schemaVersion !== MASTER_SCHEMA_VERSION || original.sourceType !== 'institution') {
    fail('failed-precondition', 'Unsupported master content schema.')
  }
  if (!['draft', 'archived'].includes(original.status)) {
    fail('failed-precondition', 'Active package content must be managed by the publishing workflow in P4D.')
  }
  const update = { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }
  if (Object.hasOwn(changes, 'title')) {
    const title = cleanString(changes.title, 180)
    if (title.length < 2) fail('invalid-argument', 'Title must contain at least 2 characters.')
    update.title = title
    update['content.title'] = title
  }
  if (Object.hasOwn(changes, 'description')) {
    update.description = cleanString(changes.description, 600)
  }
  if (Object.hasOwn(changes, 'status')) {
    if (!['draft', 'archived'].includes(changes.status)) {
      fail('invalid-argument', 'P4C allows only draft or archived status.')
    }
    update.status = changes.status
  }
  await ref.update(update, { lastUpdateTime: snap.updateTime })
  return { ok: true, masterId }
})

// Non-answer-bearing inspection for managers. The complete answer-bearing
// document stays server-side. This is a metadata/structure preview, not the
// learner test UI (implemented with entitlements in P4D).
exports.getSelfStudyMasterPreview = onCall({ invoker: 'public' }, async request => {
  await requireManager(request)
  const masterId = checkId(request.data?.masterId, 'Master ID')
  const snapshot = await getFirestore().doc(`${MASTER_COLLECTION}/${masterId}`).get()
  if (!snapshot.exists) fail('not-found', 'Master content was not found.')
  const master = snapshot.data() || {}
  const content = master.content || {}
  const questions = Array.isArray(content.questions) ? content.questions : []
  const questionSamples = questions.slice(0, 6).map(question => ({
    type: cleanString(question.type, 50),
    title: cleanString(question.title, 110),
    prompt: cleanString(question.question || question.instruction, 240),
    items: Array.isArray(question.items) ? question.items.length :
      Array.isArray(question.rows) ? question.rows.length : 0
  }))
  return {
    ok: true,
    master: infoForMaster(snapshot),
    preview: {
      passageExcerpt: cleanString(content.passage, 850),
      instructions: cleanString(content.instructions, 500),
      questions: questionSamples,
      listeningParts: (Array.isArray(content.parts) ? content.parts : []).slice(0, 8)
        .map(part => ({ title: cleanString(part.title, 120), questions: Array.isArray(part.questions) ? part.questions.length : 0 })),
      writingTask1: cleanString(content.task1?.prompt, 600),
      writingTask2: cleanString(content.task2?.prompt, 600),
      task1HasImage: Boolean(content.task1?.image),
      hasAudioCopy: Boolean(content.audioStoragePath),
      linkedMasterContentIds: Array.isArray(master.linkedMasterContentIds) ? master.linkedMasterContentIds : []
    }
  }
})
