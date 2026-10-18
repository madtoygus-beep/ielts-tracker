/**
 * Build display-only Writing sources for saved submissions whose source
 * homework is not present in the staff member's loaded library.
 *
 * Caller MUST supply only Firestore-rule-authorized submission documents and
 * must check the intended student before displaying. No extra permissions,
 * assignment grants, archive changes or writes are performed here.
 */
export function buildMissingWritingReviewSources({
  submissions = [],
  writings = [],
  student,
  belongsToStudent
} = {}) {
  if (!student || typeof belongsToStudent !== 'function') return []

  const visibleIds = new Set((Array.isArray(writings) ? writings : [])
    .map(item => String(item?.id || '').trim().toLowerCase())
    .filter(Boolean))

  const missing = new Map()

  for (const submission of (Array.isArray(submissions) ? submissions : [])) {
    if (!submission || !belongsToStudent(submission, student)) continue
    const writingId = typeof submission.writingId === 'string'
      ? submission.writingId.trim() : ''
    if (!writingId || visibleIds.has(writingId.toLowerCase()) ||
      missing.has(writingId.toLowerCase())) continue

    const suppliedTitle = typeof submission.writingTitle === 'string'
      ? submission.writingTitle.trim()
      : typeof submission.title === 'string' ? submission.title.trim() : ''

    missing.set(writingId.toLowerCase(), {
      id: writingId,
      // A source may have been archived, deleted or restricted to another
      // teacher. Never claim the original assignment has been recovered.
      title: suppliedTitle || `Saved Writing submission (${writingId.slice(0, 8)})`,
      writingMode: submission.writingMode || submission.contentType || 'full_writing',
      task1: {},
      task2: {},
      missingContent: true,
      createdAt: submission.submittedAt || ''
    })
  }

  return [...missing.values()]
}
