// P8-C: submit only changed student memberships, with per-student optimistic
// expectations. Unrelated edits from other managers cannot be removed.
export function buildP8CAssignmentDelta(contentType, contentId, before, after) {
  const from = new Set((Array.isArray(before) ? before : []).filter(Boolean))
  const to = new Set((Array.isArray(after) ? after : []).filter(Boolean))
  const changes = [
    ...[...to].filter(studentId => !from.has(studentId))
      .map(studentId => ({ studentId, assigned: true, expectedAssigned: false })),
    ...[...from].filter(studentId => !to.has(studentId))
      .map(studentId => ({ studentId, assigned: false, expectedAssigned: true }))
  ]
  return { contentType, contentId, changes }
}
