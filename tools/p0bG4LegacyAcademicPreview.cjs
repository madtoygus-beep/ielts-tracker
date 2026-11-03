'use strict'
// G4 OFFLINE SAFETY CLASSIFIER. This module has NO Firebase SDK, network,
// update, delete, bulkWriter, CLI --apply or production project connection.
// It can preview data from an already authorized local export, NOT authorize
// a migration. Manual review + live preconditioned transactions are required.
const COLLECTIONS = Object.freeze(new Set([
  'scores', 'readingSubmissions', 'writingSubmissions', 'listeningSubmissions',
  'vocabularySubmissions', 'mockSubmissions'
]))
const validId = x => typeof x === 'string' && x.length >= 1 && x.length <= 128 &&
  x === x.trim() && !x.includes('/')

function classifyLegacyIdentity({collection, docId, record, profile, profileUid}) {
  const skip = (kind, reason) => ({kind, reason, updates: {}})
  if (!COLLECTIONS.has(collection) || !validId(docId) ||
      !record || typeof record !== 'object' || Array.isArray(record)) {
    return skip('manual_review', 'invalid_collection_or_document')
  }
  if (!validId(profileUid) || !profile || profile.role !== 'student' ||
      profile.status !== 'approved' || profile.deleted === true ||
      profile.archived === true || profile.permanentDeleteInProgress === true ||
      !validId(profile.schoolId)) {
    return skip('manual_review', 'unverified_or_inactive_student')
  }
  if (profile.accountType && String(profile.accountType).toLowerCase() !== 'institution') {
    return skip('manual_review', 'non_institution_student')
  }
  const present = name => Object.hasOwn(record, name) &&
    record[name] !== undefined && record[name] !== null && record[name] !== ''
  for (const name of ['uid', 'studentId', 'schoolId']) {
    if (present(name) && !validId(record[name])) {
      return skip('conflict', 'invalid_' + name)
    }
  }
  if (present('uid') && record.uid !== profileUid ||
      present('studentId') && record.studentId !== profileUid) {
    return skip('conflict', 'stored_identity_disagrees_with_student_profile')
  }
  // An unowned record cannot be safely assigned merely because its document
  // ID happens to resemble a UID. Never infer an owner from ID/teacherIds.
  if (!present('uid') && !present('studentId')) {
    return skip('manual_review', 'no_stored_student_identity')
  }
  if (present('schoolId') && record.schoolId !== profile.schoolId) {
    return skip('conflict', 'stored_institution_mismatch')
  }
  // Missing schoolId has a historic implicit `maxima` fallback in rules.
  // Do not infer membership for a different school without source evidence.
  if (!present('schoolId') && profile.schoolId !== 'maxima') {
    return skip('manual_review', 'missing_school_on_nondefault_institution')
  }
  const updates = {}
  if (!present('uid')) updates.uid = profileUid
  if (!present('studentId')) updates.studentId = profileUid
  if (!present('schoolId')) updates.schoolId = profile.schoolId
  return Object.keys(updates).length
    ? {kind:'candidate_preview_only',reason:'identity_consistent',updates}
    : skip('already_canonical', 'no_changes')
}

module.exports = { COLLECTIONS, classifyLegacyIdentity }
