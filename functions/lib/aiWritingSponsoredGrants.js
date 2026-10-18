'use strict'

// P8-B1: per-student grants. Legacy v1 policies had one updatedBy/updatedAt
// for EVERY student. Read legacy grants without mutating Firestore; migrate
// atomically on the first actual v2 policy write.
const UID = /^[A-Za-z0-9_-]{6,128}$/
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const validUid = id => typeof id === 'string' && UID.test(id) &&
  !['__proto__', 'constructor', 'prototype'].includes(id)

function timestampMs(value) {
  const ms = typeof value?.toMillis === 'function' ? value.toMillis()
    : value instanceof Date ? value.getTime()
      : typeof value === 'string' ? Date.parse(value) : value
  return Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER ? ms : null
}

function validGrant(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    validUid(value.grantedBy) &&
    (value.grantedAtMs === null || timestampMs(value.grantedAtMs) !== null)
}

function grantMapIsConsistent(policy) {
  if (!policy || !Array.isArray(policy.studentIds) ||
      policy.studentIds.some(uid => !validUid(uid)) ||
      new Set(policy.studentIds).size !== policy.studentIds.length) return false
  if (!has(policy, 'grants')) return true // read-only legacy v1
  if (!policy.grants || typeof policy.grants !== 'object' || Array.isArray(policy.grants)) return false
  const ids = Object.keys(policy.grants)
  return ids.length === policy.studentIds.length &&
    ids.every(id => validUid(id) && policy.studentIds.includes(id) && validGrant(policy.grants[id]))
}

function grantForStudent(policy, studentId) {
  if (!policy || policy.enabled !== true || !validUid(studentId) ||
      !Array.isArray(policy.studentIds) || !policy.studentIds.includes(studentId) ||
      !grantMapIsConsistent(policy)) return null
  if (has(policy, 'grants')) {
    return has(policy.grants, studentId) ? policy.grants[studentId] : null
  }
  // Legacy policy: its last editor was originally considered the issuer of
  // every listed grant. Do not fabricate missing timestamps for Mock billing.
  if (!validUid(policy.updatedBy)) return null
  return { grantedBy: policy.updatedBy, grantedAtMs: timestampMs(policy.updatedAt) }
}

function grantsForPolicy(policy) {
  const grants = {}
  if (!policy?.enabled || !grantMapIsConsistent(policy)) return grants
  for (const uid of policy.studentIds) {
    const grant = grantForStudent(policy, uid)
    if (grant) Object.defineProperty(grants, uid, { value: {
      grantedBy: grant.grantedBy, grantedAtMs: grant.grantedAtMs
    }, enumerable: true, writable: true, configurable: true })
  }
  return grants
}

module.exports = {
  validUid, timestampMs, validGrant, grantMapIsConsistent,
  grantForStudent, grantsForPolicy
}
