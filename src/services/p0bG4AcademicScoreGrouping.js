// G4: presentation-only grouping of scores, including verified legacy records
// that have studentId but no uid. Never treat conflicting identities as a
// valid learner. Teacher Firestore collection queries remain canonical and
// server rules stay fail-closed; this only restores ADMIN UI legacy grouping.
const safeUid = value => typeof value === 'string' &&
  value.length > 0 && value.length <= 128 && value.trim() === value &&
  !value.includes('/')

export function groupScoresByStudent(scoreItems) {
  const grouped = Object.create(null)
  for (const score of Array.isArray(scoreItems) ? scoreItems : []) {
    if (!score || typeof score !== 'object' || Array.isArray(score)) continue
    const uid = safeUid(score.uid) ? score.uid : ''
    const legacyId = safeUid(score.studentId) ? score.studentId : ''
    // A malformed nonempty identity must not be silently overridden by the
    // other identity. An explicit disagreement requires administrator repair.
    if ((score.uid != null && score.uid !== '' && !uid) ||
        (score.studentId != null && score.studentId !== '' && !legacyId) ||
        (uid && legacyId && uid !== legacyId)) continue
    const studentId = uid || legacyId
    if (!studentId) continue
    if (!Object.hasOwn(grouped, studentId)) grouped[studentId] = []
    grouped[studentId].push(score)
  }
  for (const items of Object.values(grouped)) {
    items.sort((a, b) => (Date.parse(b.date || b.createdAt || '') || 0) -
      (Date.parse(a.date || a.createdAt || '') || 0))
  }
  return grouped
}
