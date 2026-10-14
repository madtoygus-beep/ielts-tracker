// P5B-1 — UI validation only; Firebase Cloud Functions enforce authorization.
export const PILOT_SCHOOL_ID = 'maxima'

export function isEligiblePilotStudent(user) {
  return Boolean(
    user && typeof user.id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(user.id) &&
    user.role === 'student' && user.status === 'approved' &&
    user.deleted !== true && user.archived !== true &&
    (user.schoolId || PILOT_SCHOOL_ID) === PILOT_SCHOOL_ID &&
    (user.accountType === 'institution' || user.accountType == null) &&
    user.schoolId !== '__individual__'
  )
}

export function eligiblePilotStudents(users) {
  if (!Array.isArray(users)) return []
  return users.filter(isEligiblePilotStudent).sort((a, b) =>
    String(a.name || a.email || a.id).localeCompare(String(b.name || b.email || b.id), 'en'))
}

export function parseCreditDelta(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  if (!/^-?\d{1,3}$/.test(text)) return null
  const number = Number(text)
  return Number.isSafeInteger(number) && number >= -100 && number <= 100 ? number : null
}

export function preparePilotChange({ studentId, creditsRemaining, previousEnabled, enabled, delta, requestId }) {
  if (typeof studentId !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(studentId)) {
    throw new Error('Choose a valid institution student.')
  }
  if (!Number.isSafeInteger(creditsRemaining) || creditsRemaining < 0 || creditsRemaining > 1000) {
    throw new Error('Reload the student credit balance before continuing.')
  }
  if (typeof enabled !== 'boolean') throw new Error('Invalid access setting.')
  const creditDelta = parseCreditDelta(delta)
  if (creditDelta === null) throw new Error('Credit adjustment must be a whole number between -100 and 100.')
  if (enabled === previousEnabled && creditDelta === 0) throw new Error('No changes to save.')
  const newBalance = creditsRemaining + creditDelta
  if (newBalance < 0 || newBalance > 1000) throw new Error('Resulting credit balance is out of range.')
  if (enabled && newBalance === 0) throw new Error('Give at least one credit before enabling a student.')
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    throw new Error('Invalid operation identifier.')
  }
  return { studentId, enabled, creditDelta, requestId }
}

// Keep the *same* requestId after a failed/uncertain network response; a retry
// must not charge the student twice. A changed request gets a fresh ID.
export function nextPendingOperation(previous, signature, makeId) {
  if (previous && previous.signature === signature) return previous
  const id = makeId()
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw new Error('Could not create an operation identifier.')
  }
  return { signature, requestId: id }
}
