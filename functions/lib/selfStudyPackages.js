'use strict'

// P4D: Server-authoritative Self-Study package catalog, free samples,
// manual entitlements, and separately authorized learner practice.
// Payment and automatic purchase activation belong to P8A.

const { createHash } = require('node:crypto')
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { getFirestore, FieldPath, FieldValue, Timestamp } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const {
  sanitizeReading, sanitizeListening, sanitizeVocabulary,
  gradeReading, gradeListening, gradeVocabulary, buildVocabularyDefinitionOrder
} = require('./grading')

const db = getFirestore()
const PACKAGES = 'selfStudyPackages'
const ENTITLEMENTS = 'selfStudyEntitlements'
const SETTINGS = 'selfStudySettings/catalog'
const MASTERS = 'masterContent'
const ATTEMPTS = 'selfStudyAttempts'
const STORAGE_BUCKET = 'maxima-tracker.firebasestorage.app'
const MANAGER_ROLE = 'selfStudyManager'
const INDIVIDUAL_ID = '__individual__'
const PLATFORM_ID = '__platform__'
const TYPES = new Set(['reading', 'listening', 'writing', 'vocabulary', 'mock'])
const STATUSES = new Set(['draft', 'active', 'archived'])
const CURRENCIES = new Set(['TRY', 'EUR', 'USD', 'GBP'])
const MAX_PACKAGES = 200
const MAX_CONTENT = 35
const MAX_SAMPLES = 25
const MAX_ANSWERS_BYTES = 80000
// Temporary P4D foundation pause. Keep package, grant and attempt records intact.
// Enable only after individual practice achieves institution UI parity and passes
// a new end-to-end regression/security review.
const INDIVIDUAL_PRACTICE_PAUSED = true

function fail(code, message) { throw new HttpsError(code, message) }
function idOf(value, name = 'ID') {
  if (typeof value !== 'string') fail('invalid-argument', `${name} must be a string.`)
  const clean = value.trim()
  if (!clean || clean.length > 160 || clean.includes('/') || clean === '.' || clean === '..') fail('invalid-argument', `Invalid ${name}.`)
  return clean
}
function stringOf(value, limit = 180) { return typeof value === 'string' ? value.trim().slice(0, limit) : '' }
function yes(value) { return value === true }
function uniqueIds(value, max = MAX_CONTENT) {
  if (!Array.isArray(value) || value.length > max) fail('invalid-argument', `Expected at most ${max} content IDs.`)
  const out = value.map(item => idOf(item, 'content ID'))
  if (new Set(out).size !== out.length) fail('invalid-argument', 'Content IDs must be unique.')
  return out
}
function accountProfile(snap) { return snap.exists ? (snap.data() || {}) : null }
function validIndividual(profile) {
  return profile?.role === 'student' && profile?.accountType === 'individual' &&
    profile?.schoolId === INDIVIDUAL_ID && profile?.status === 'approved' && profile?.deleted !== true
}
function validManager(profile) {
  return profile?.role === MANAGER_ROLE && profile?.accountType === 'platform' &&
    profile?.scope === 'selfStudy' && profile?.schoolId === PLATFORM_ID &&
    profile?.status === 'approved' && profile?.deleted !== true
}
async function requireProfile(request, type) {
  if (!request.auth?.uid) fail('unauthenticated', 'Please sign in.')
  const snap = await db.doc(`users/${request.auth.uid}`).get()
  const profile = accountProfile(snap)
  const authorized = type === 'manager' ? validManager(profile) : validIndividual(profile)
  if (!authorized) fail('permission-denied', `An active ${type === 'manager' ? 'Self-Study Manager' : 'individual learner'} account is required.`)
  return { uid: request.auth.uid, profile }
}
function infoMaster(snap) {
  const m = snap.data() || {}
  return {
    id: snap.id, title: stringOf(m.title) || 'Untitled',
    contentType: TYPES.has(m.contentType) ? m.contentType : '',
    status: m.status || 'draft', blockCount: Number(m.blockCount) || 0,
    linkedFromMasterMockId: m.linkedFromMasterMockId || null,
    linkedMasterContentIds: Array.isArray(m.linkedMasterContentIds) ? m.linkedMasterContentIds : []
  }
}
function infoPackage(snap) {
  const p = snap.data() || {}
  return {
    id: snap.id, title: stringOf(p.title) || 'Untitled', description: stringOf(p.description, 600),
    status: p.status || 'draft', accessType: p.accessType === 'free' ? 'free' : 'paid',
    priceMinor: Number.isSafeInteger(p.priceMinor) ? p.priceMinor : 0,
    currency: CURRENCIES.has(p.currency) ? p.currency : 'TRY',
    contentIds: Array.isArray(p.contentIds) ? p.contentIds : [],
    featured: p.featured === true, order: Number.isInteger(p.order) ? p.order : 0,
    purchaseEnabled: false, // P8A only. Never trust client-supplied payment state.
    createdAt: p.createdAt?.toDate?.().toISOString() || null,
    updatedAt: p.updatedAt?.toDate?.().toISOString() || null
  }
}
function infoEntitlement(snap) {
  const e = snap.data() || {}
  return {
    id: snap.id, userId: e.userId, packageId: e.packageId,
    status: e.status, source: e.source,
    grantedAt: e.grantedAt?.toDate?.().toISOString() || null,
    expiresAt: e.expiresAt?.toDate?.().toISOString() || null,
    revokedAt: e.revokedAt?.toDate?.().toISOString() || null
  }
}
function entitlementId(uid, packageId) {
  const hashed = createHash('sha256').update(`${uid}|${packageId}`).digest('hex').slice(0, 48)
  return `se_${hashed}`
}
function entitlementActive(e, now = Date.now()) {
  if (!e || e.status !== 'active' || !['admin_grant', 'purchase'].includes(e.source)) return false
  if (e.expiresAt?.toMillis && e.expiresAt.toMillis() <= now) return false
  return true
}
async function getMasters(ids, { rootOnly = false } = {}) {
  const refs = ids.map(id => db.doc(`${MASTERS}/${id}`))
  const snaps = refs.length ? await db.getAll(...refs) : []
  for (let i = 0; i < snaps.length; i++) {
    const snap = snaps[i]
    if (!snap.exists) fail('failed-precondition', `Master content ${ids[i]} was not found.`)
    const m = snap.data() || {}
    if (m.schemaVersion !== 1 || !TYPES.has(m.contentType) || m.status === 'archived') {
      fail('failed-precondition', `Master content ${ids[i]} is not available for publication.`)
    }
    if (rootOnly && m.linkedFromMasterMockId) {
      fail('failed-precondition', 'Linked Mock resources cannot be published separately. Add the Mock root instead.')
    }
  }
  return snaps
}
async function getPackageSnaps() {
  const result = await db.collection(PACKAGES).limit(MAX_PACKAGES + 1).get()
  if (result.size > MAX_PACKAGES) fail('resource-exhausted', 'Package limit reached. Contact the platform administrator.')
  return result.docs
}
async function getSamples() {
  const snap = await db.doc(SETTINGS).get()
  const ids = snap.data()?.freeSampleContentIds
  return Array.isArray(ids) ? ids : []
}
function validatePackage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid-argument', 'Invalid package changes.')
  const keys = Object.keys(data)
  const allowed = new Set(['title', 'description', 'accessType', 'priceMinor', 'currency', 'contentIds', 'featured', 'order'])
  if (!keys.length || keys.some(key => !allowed.has(key))) fail('invalid-argument', 'Unsupported package field.')
  const result = {}
  if (Object.hasOwn(data, 'title')) {
    result.title = stringOf(data.title, 140)
    if (result.title.length < 3) fail('invalid-argument', 'Package title must be at least 3 characters.')
  }
  if (Object.hasOwn(data, 'description')) result.description = stringOf(data.description, 600)
  if (Object.hasOwn(data, 'accessType')) {
    if (!['free', 'paid'].includes(data.accessType)) fail('invalid-argument', 'Invalid access type.')
    result.accessType = data.accessType
  }
  if (Object.hasOwn(data, 'currency')) {
    if (!CURRENCIES.has(data.currency)) fail('invalid-argument', 'Unsupported currency.')
    result.currency = data.currency
  }
  if (Object.hasOwn(data, 'priceMinor')) {
    if (!Number.isSafeInteger(data.priceMinor) || data.priceMinor < 0 || data.priceMinor > 100000000) {
      fail('invalid-argument', 'Price must be an integer amount in minor currency units.')
    }
    result.priceMinor = data.priceMinor
  }
  if (Object.hasOwn(data, 'contentIds')) result.contentIds = uniqueIds(data.contentIds)
  if (Object.hasOwn(data, 'featured')) result.featured = yes(data.featured)
  if (Object.hasOwn(data, 'order')) {
    if (!Number.isInteger(data.order) || data.order < 0 || data.order > 100000) fail('invalid-argument', 'Invalid display order.')
    result.order = data.order
  }
  return result
}
function validateEffectivePackage(data) {
  if (data.accessType === 'free' && data.priceMinor !== 0) fail('invalid-argument', 'Free packages must have zero price.')
  if (data.accessType === 'paid' && data.priceMinor <= 0) fail('invalid-argument', 'Paid packages need a positive price.')
}
async function userEntitlements(uid) {
  const snap = await db.collection(ENTITLEMENTS).where('userId', '==', uid).limit(MAX_PACKAGES + 1).get()
  if (snap.size > MAX_PACKAGES) fail('resource-exhausted', 'Too many entitlements.')
  return snap.docs
}

exports.listSelfStudyPackages = onCall({ invoker: 'public' }, async request => {
  await requireProfile(request, 'manager')
  const docs = await getPackageSnaps()
  return { ok: true, packages: docs.map(infoPackage).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)) }
})

exports.saveSelfStudyPackage = onCall({ invoker: 'public' }, async request => {
  const manager = await requireProfile(request, 'manager')
  const changes = validatePackage(request.data?.changes)
  const id = request.data?.packageId ? idOf(request.data.packageId, 'package ID') : null
  const ref = id ? db.doc(`${PACKAGES}/${id}`) : db.collection(PACKAGES).doc()
  const before = id ? await ref.get() : null
  if (id && !before.exists) fail('not-found', 'Package no longer exists.')
  const initial = before?.data() || {
    title: '', description: '', status: 'draft', accessType: 'paid',
    priceMinor: 0, currency: 'TRY', contentIds: [], featured: false, order: 0
  }
  const effective = { ...initial, ...changes }
  if (!effective.title || effective.title.length < 3) fail('invalid-argument', 'Package title is required.')
  // Draft paid packages may be edited before a price is set.
  if (effective.status === 'active') validateEffectivePackage(effective)
  if (effective.accessType === 'free') effective.priceMinor = 0
  if (effective.contentIds.length > MAX_CONTENT) fail('invalid-argument', 'Too many content items.')
  if (effective.contentIds.length) await getMasters(effective.contentIds, { rootOnly: true })
  const patch = {
    ...changes,
    ...(effective.accessType === 'free' ? { priceMinor: 0 } : {}),
    updatedBy: manager.uid, updatedAt: FieldValue.serverTimestamp(),
    purchaseEnabled: false
  }
  if (id) {
    await ref.update(patch, { lastUpdateTime: before.updateTime })
  } else {
    await ref.create({ ...initial, ...patch, schemaVersion: 1,
      createdAt: FieldValue.serverTimestamp(), createdBy: manager.uid })
  }
  return { ok: true, packageId: ref.id }
})

exports.setSelfStudyPackageStatus = onCall({ invoker: 'public' }, async request => {
  const manager = await requireProfile(request, 'manager')
  const id = idOf(request.data?.packageId, 'package ID')
  const status = request.data?.status
  if (!STATUSES.has(status)) fail('invalid-argument', 'Invalid package status.')
  const ref = db.doc(`${PACKAGES}/${id}`)
  const snap = await ref.get()
  if (!snap.exists) fail('not-found', 'Package was not found.')
  const p = snap.data() || {}
  if (status === 'active') {
    if (!Array.isArray(p.contentIds) || !p.contentIds.length) fail('failed-precondition', 'Add at least one master content item first.')
    validateEffectivePackage(p)
    await getMasters(p.contentIds, { rootOnly: true })
  }
  await ref.update({ status, updatedBy: manager.uid, updatedAt: FieldValue.serverTimestamp() }, { lastUpdateTime: snap.updateTime })
  return { ok: true, packageId: id, status }
})

exports.getSelfStudyFreeSamples = onCall({ invoker: 'public' }, async request => {
  await requireProfile(request, 'manager')
  return { ok: true, contentIds: await getSamples() }
})

exports.setSelfStudyFreeSamples = onCall({ invoker: 'public' }, async request => {
  const manager = await requireProfile(request, 'manager')
  const contentIds = uniqueIds(request.data?.contentIds, MAX_SAMPLES)
  await getMasters(contentIds, { rootOnly: true })
  await db.doc(SETTINGS).set({ schemaVersion: 1, freeSampleContentIds: contentIds,
    updatedBy: manager.uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  return { ok: true, contentIds }
})

exports.listSelfStudyLearners = onCall({ invoker: 'public' }, async request => {
  await requireProfile(request, 'manager')
  const email = stringOf(request.data?.email, 320).toLowerCase()
  let docs
  if (email) {
    if (!/^\S+@\S+\.\S+$/.test(email)) fail('invalid-argument', 'Enter a valid full email address.')
    docs = (await db.collection('users').where('email', '==', email).limit(10).get()).docs
  } else {
    docs = (await db.collection('users').where('accountType', '==', 'individual').limit(100).get()).docs
  }
  const learners = docs.filter(s => {
    const p = s.data() || {}
    return p.role === 'student' && p.accountType === 'individual' && p.schoolId === INDIVIDUAL_ID
  }).map(s => ({ uid: s.id, name: stringOf(s.data().name || s.data().fullName, 160),
    email: stringOf(s.data().email, 320), status: s.data().status || '', deleted: s.data().deleted === true }))
  return { ok: true, learners, limited: !email && docs.length === 100 }
})

exports.listSelfStudyEntitlements = onCall({ invoker: 'public' }, async request => {
  await requireProfile(request, 'manager')
  const uid = idOf(request.data?.userId, 'learner UID')
  // Read-only manager view may include archived individual accounts.
  const p = accountProfile(await db.doc(`users/${uid}`).get())
  if (!p || p.role !== 'student' || p.accountType !== 'individual' || p.schoolId !== INDIVIDUAL_ID) {
    fail('permission-denied', 'Only individual learner access is managed here.')
  }
  const docs = await userEntitlements(uid)
  return { ok: true, entitlements: docs.map(infoEntitlement) }
})

exports.grantSelfStudyPackage = onCall({ invoker: 'public' }, async request => {
  const manager = await requireProfile(request, 'manager')
  const uid = idOf(request.data?.userId, 'learner UID')
  const packageId = idOf(request.data?.packageId, 'package ID')
  const dateString = request.data?.expiresAt
  let expiresAt = null
  if (dateString !== undefined && dateString !== null && dateString !== '') {
    if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(dateString)) {
      fail('invalid-argument', 'Provide an ISO UTC expiry date.')
    }
    const millis = Date.parse(dateString)
    if (!Number.isFinite(millis) || new Date(millis).toISOString() !== dateString || millis <= Date.now() || millis > Date.now() + 10 * 365 * 86400000) {
      fail('invalid-argument', 'Expiry must be a valid future date within 10 years.')
    }
    expiresAt = Timestamp.fromMillis(millis)
  }
  const ref = db.doc(`${ENTITLEMENTS}/${entitlementId(uid, packageId)}`)
  const learnerRef = db.doc(`users/${uid}`)
  const packageRef = db.doc(`${PACKAGES}/${packageId}`)
  await db.runTransaction(async tx => {
    const [learnerSnap, packageSnap, existing] = await Promise.all([
      tx.get(learnerRef), tx.get(packageRef), tx.get(ref)
    ])
    if (!validIndividual(accountProfile(learnerSnap))) fail('failed-precondition', 'Learner account is not active.')
    if (!packageSnap.exists || packageSnap.data()?.status !== 'active') fail('failed-precondition', 'Package must be active before granting access.')
    const current = existing.data() || {}
    if (current.source === 'purchase') fail('failed-precondition', 'Purchase-created access cannot be replaced by a manual grant.')
    tx.set(ref, {
      schemaVersion: 1, userId: uid, packageId, source: 'admin_grant', status: 'active',
      grantedAt: FieldValue.serverTimestamp(), grantedBy: manager.uid,
      expiresAt, revokedAt: null, revokedBy: null,
      createdAt: current.createdAt || FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    })
  })
  return { ok: true, userId: uid, packageId }
})

exports.revokeSelfStudyPackage = onCall({ invoker: 'public' }, async request => {
  const manager = await requireProfile(request, 'manager')
  const uid = idOf(request.data?.userId, 'learner UID')
  const packageId = idOf(request.data?.packageId, 'package ID')
  const ref = db.doc(`${ENTITLEMENTS}/${entitlementId(uid, packageId)}`)
  const snap = await ref.get()
  if (!snap.exists || snap.data()?.userId !== uid || snap.data()?.packageId !== packageId) fail('not-found', 'Entitlement was not found.')
  if (snap.data()?.source === 'purchase') fail('failed-precondition', 'Purchase-created access must follow the P8A refund/cancellation process.')
  await ref.update({ status: 'revoked', revokedAt: FieldValue.serverTimestamp(),
    revokedBy: manager.uid, updatedAt: FieldValue.serverTimestamp() }, { lastUpdateTime: snap.updateTime })
  return { ok: true, userId: uid, packageId }
})

async function accessForLearner(uid, masterSnap) {
  const allPackages = await getPackageSnaps()
  const visiblePackages = allPackages.filter(s => s.data()?.status === 'active')
  const grants = await userEntitlements(uid)
  const activeGrantIds = new Map(grants.filter(s => entitlementActive(s.data())).map(s => [s.data().packageId, s.data().source]))
  const freeSamples = await getSamples()
  const master = masterSnap.data() || {}
  let rootId = masterSnap.id
  if (master.linkedFromMasterMockId) {
    rootId = idOf(master.linkedFromMasterMockId, 'Mock root ID')
    const rootSnap = await db.doc(`${MASTERS}/${rootId}`).get()
    if (!rootSnap.exists || rootSnap.data()?.contentType !== 'mock' ||
        rootSnap.data()?.status === 'archived' ||
        !Array.isArray(rootSnap.data()?.linkedMasterContentIds) ||
        !rootSnap.data().linkedMasterContentIds.includes(masterSnap.id)) {
      fail('permission-denied', 'Linked Mock content is unavailable.')
    }
  }
  if (freeSamples.includes(rootId)) return { source: 'free_sample', packageId: null }
  for (const snap of visiblePackages) {
    const p = snap.data() || {}
    if (!Array.isArray(p.contentIds) || !p.contentIds.includes(rootId)) continue
    if (p.accessType === 'free') return { source: 'free_package', packageId: snap.id }
    if (activeGrantIds.has(snap.id)) return { source: activeGrantIds.get(snap.id), packageId: snap.id }
  }
  fail('permission-denied', 'This practice activity is locked. An active package grant is required.')
}

exports.getSelfStudyCatalog = onCall({ invoker: 'public' }, async request => {
  const { uid } = await requireProfile(request, 'learner')
  const packages = (await getPackageSnaps()).filter(s => s.data()?.status === 'active')
  const grants = await userEntitlements(uid)
  const granted = new Map(grants.filter(s => entitlementActive(s.data())).map(s => [s.data().packageId, s.data()]))
  const freeSamples = await getSamples()
  const ids = [...new Set([...freeSamples, ...packages.flatMap(s => s.data()?.contentIds || [])])]
  if (ids.length > 1500) fail('resource-exhausted', 'Catalog is too large.')
  const masterSnaps = ids.length ? await db.getAll(...ids.map(id => db.doc(`${MASTERS}/${id}`))) : []
  const masters = masterSnaps.filter(s => s.exists && s.data()?.status !== 'archived')
    .map(s => infoMaster(s)).filter(m => !m.linkedFromMasterMockId)
  const allowed = new Set(masters.map(m => m.id))
  return {
    ok: true,
    freeSamples: freeSamples.filter(id => allowed.has(id)),
    content: masters,
    packages: packages.map(s => ({ ...infoPackage(s),
      contentIds: (s.data()?.contentIds || []).filter(id => allowed.has(id)),
      hasAccess: s.data()?.accessType === 'free' || granted.has(s.id),
      accessReason: s.data()?.accessType === 'free' ? 'free' : (granted.get(s.id)?.source || 'locked'),
      expiresAt: (() => {
        const doc = grants.find(g => g.data()?.packageId === s.id && entitlementActive(g.data()))
        return doc?.data()?.expiresAt?.toDate?.().toISOString() || null
      })()
    })).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
  }
})

const SECRET_KEY = /(answer|correct|solution|explan|rubric|markscheme|scoringkey|teachernote|marking|isright)/i
function stripKeys(node, depth = 0) {
  if (depth > 40) fail('failed-precondition', 'Activity content is too deeply nested.')
  if (Array.isArray(node)) return node.map(item => stripKeys(item, depth + 1))
  if (node === null || typeof node !== 'object') return node
  const result = {}
  for (const [k, v] of Object.entries(node)) {
    if (SECRET_KEY.test(k) || /StoragePath$/i.test(k) || k === 'assetManifest') continue
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    result[k] = stripKeys(v, depth + 1)
  }
  return result
}

async function prepareSignedMedia(payload, masterId) {
  const bucket = getStorage().bucket(STORAGE_BUCKET)
  const prefix = `self-study-master/${masterId}/assets/`
  const signed = new Map()
  let mediaCount = 0
  async function visit(node, depth = 0) {
    if (depth > 35) fail('failed-precondition', 'Media content is too deeply nested.')
    if (Array.isArray(node)) return Promise.all(node.map(child => visit(child, depth + 1)))
    if (!node || typeof node !== 'object') return node
    const out = {}
    for (const [k, value] of Object.entries(node)) {
      if (/StoragePath$/i.test(k)) {
        if (!value) continue
        if (typeof value !== 'string' || !value.startsWith(prefix) || value.slice(prefix.length).includes('/')) {
          fail('failed-precondition', 'Invalid protected media reference.')
        }
        if (!signed.has(value)) {
          mediaCount += 1
          if (mediaCount > 15) fail('failed-precondition', 'Too many media files in one activity.')
          const urls = await bucket.file(value).getSignedUrl({ action: 'read', expires: Date.now() + 15 * 60 * 1000, version: 'v4' })
          signed.set(value, urls[0])
        }
        const replacement = k === 'audioStoragePath' ? 'audioUrl' : k === 'mapImageStoragePath' ? 'mapImageUrl' : `${k.slice(0, -11)}Url`
        out[replacement] = signed.get(value)
      } else {
        out[k] = await visit(value, depth + 1)
      }
    }
    return out
  }
  return visit(payload)
}

exports.getSelfStudyActivity = onCall({ invoker: 'public', memory: '512MiB' }, async request => {
  const { uid } = await requireProfile(request, 'learner')
  if (INDIVIDUAL_PRACTICE_PAUSED) fail('failed-precondition', 'Individual practice is temporarily paused while we improve the learner experience.')
  const masterId = idOf(request.data?.masterId, 'master content ID')
  const snap = await db.doc(`${MASTERS}/${masterId}`).get()
  if (!snap.exists || snap.data()?.status === 'archived' || snap.data()?.schemaVersion !== 1) fail('not-found', 'Activity is unavailable.')
  const access = await accessForLearner(uid, snap)
  const m = snap.data()
  if (!TYPES.has(m.contentType)) fail('failed-precondition', 'Unsupported activity type.')
  const content = m.content || {}
  let safe
  if (m.contentType === 'reading') safe = sanitizeReading({ id: masterId, ...content })
  else if (m.contentType === 'listening') safe = sanitizeListening({ id: masterId, ...content })
  else if (m.contentType === 'vocabulary') safe = sanitizeVocabulary({ id: masterId, ...content })
  else safe = { ...content }
  // Defense in depth: remove any answer-bearing nested properties not covered by legacy sanitizer.
  safe = await prepareSignedMedia(safe, masterId)
  safe = stripKeys(safe)
  let parts = []
  if (m.contentType === 'mock') {
    const ids = Array.isArray(m.linkedMasterContentIds) ? m.linkedMasterContentIds : []
    const snaps = ids.length ? await db.getAll(...ids.map(id => db.doc(`${MASTERS}/${id}`))) : []
    parts = snaps.filter(s => s.exists && s.data()?.linkedFromMasterMockId === masterId && s.data()?.status !== 'archived').map(infoMaster)
  }
  return { ok: true, master: infoMaster(snap), access, content: safe, parts }
})

function cleanAnswers(answers, depth = 0) {
  if (depth > 5) fail('invalid-argument', 'Too many answer nesting levels.')
  if (answers === null) return ''
  if (typeof answers === 'string') return answers.slice(0, 6000)
  if (Array.isArray(answers)) {
    if (answers.length > 150) fail('invalid-argument', 'Too many answers.')
    return answers.map(v => cleanAnswers(v, depth + 1))
  }
  if (!answers || typeof answers !== 'object') fail('invalid-argument', 'Invalid answer payload.')
  if (Object.keys(answers).length > 300) fail('invalid-argument', 'Too many answer fields.')
  const cleaned = {}
  for (const [k, v] of Object.entries(answers)) {
    if (k.length > 160 || k === '__proto__' || k === 'constructor' || k === 'prototype') fail('invalid-argument', 'Invalid answer key.')
    cleaned[k] = cleanAnswers(v, depth + 1)
  }
  return cleaned
}

exports.submitSelfStudyPractice = onCall({ invoker: 'public' }, async request => {
  const { uid } = await requireProfile(request, 'learner')
  if (INDIVIDUAL_PRACTICE_PAUSED) fail('failed-precondition', 'Individual practice is temporarily paused while we improve the learner experience.')
  const masterId = idOf(request.data?.masterId, 'master content ID')
  const raw = request.data?.answers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(raw).length > MAX_ANSWERS_BYTES) {
    fail('invalid-argument', 'Invalid or oversized answers.')
  }
  const answers = cleanAnswers(raw)
  const snap = await db.doc(`${MASTERS}/${masterId}`).get()
  if (!snap.exists || snap.data()?.status === 'archived') fail('not-found', 'Activity is unavailable.')
  const access = await accessForLearner(uid, snap)
  const m = snap.data()
  const source = { id: masterId, ...(m.content || {}) }
  let result
  if (m.contentType === 'reading') result = gradeReading(source, answers)
  else if (m.contentType === 'listening') result = gradeListening(source, answers)
  else if (m.contentType === 'vocabulary') result = gradeVocabulary(source, answers)
  else if (m.contentType === 'writing') {
    const task1 = stringOf(answers.task1, 18000)
    const task2 = stringOf(answers.task2, 30000)
    if (!task1 && !task2) fail('invalid-argument', 'Enter an answer before submitting.')
    result = { status: 'pending_review', task1Words: task1.split(/\s+/).filter(Boolean).length,
      task2Words: task2.split(/\s+/).filter(Boolean).length, gradingAvailable: false }
  } else fail('failed-precondition', 'Open a Mock section to submit answers. Full timed Mock grading is not available in P4D.')
  const attempt = await db.collection(ATTEMPTS).add({ schemaVersion: 1, userId: uid,
    masterContentId: masterId, contentType: m.contentType, source: access.source,
    packageId: access.packageId || null, answers, result,
    createdAt: FieldValue.serverTimestamp() })
  return { ok: true, attemptId: attempt.id, result }
})

// Narrow pure helpers exported for offline tests; none bypass server auth.
if (process.env.MAXIMA_P4D_TEST === "1") {
  exports.__testing = { validManager, validIndividual, validatePackage, entitlementActive, stripKeys, entitlementId, cleanAnswers }
}
