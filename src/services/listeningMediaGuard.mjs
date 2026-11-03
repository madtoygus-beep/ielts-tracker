// STEP1000C7S: Browser editing guard; NOT an authorization boundary.
// Firestore Rules and/or a trusted server update validator must enforce
// the same invariants. Legacy URLs are retained, never newly introduced.
const privatePattern = /^private-listening-media\/([^/]+)\/([^/]+)\/(audio|map)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i

function value(s) { return typeof s === 'string' ? s.trim() : '' }
function fail(reason) { throw new Error('Private Listening media validation: ' + reason) }
function isPrivate(path) { return value(path).startsWith('private-listening-media/') }
function matchesPrivate(path, owner, listeningId, type) {
  const m = privatePattern.exec(value(path))
  return Boolean(m && m[1] === owner && m[2] === listeningId && m[3] === type)
}
function mapQuestions(parts) {
  const result = new Map()
  for (const part of Array.isArray(parts) ? parts : []) {
    for (const q of Array.isArray(part?.questions) ? part.questions : []) {
      if (q?.type !== 'map') continue
      const key = value(part?.id) + '::' + value(q?.id)
      if (!value(part?.id) || !value(q?.id) || result.has(key)) fail('Invalid or duplicate map identity.')
      result.set(key, q)
    }
  }
  return result
}

/**
 * Returns true for approved local changes; otherwise throws a safe error.
 * This prevents accidental downgrades via CreateListening but CAN be bypassed
 * by direct Firestore API access until complete server-side enforcement ships.
 */
export function assertListeningMediaSaveSafe({original, next, actorId, listeningId, isEditMode}) {
  if (!next || !value(actorId) || !value(listeningId)) fail('Missing editor or Listening identity.')
  if (isEditMode && !original) fail('The original Listening media was not loaded.')
  const owner = isEditMode
    ? value(original.createdBy || original.teacherId)
    : value(actorId)
  if (!owner) fail('Listening owner is missing.')

  const beforePath = isEditMode ? value(original.audioStoragePath) : ''
  const beforeUrl = isEditMode ? value(original.audioUrl) : ''
  const newPath = value(next.audioStoragePath)
  const newUrl = value(next.audioUrl)

  if (isEditMode && newPath === beforePath) {
    if (isPrivate(beforePath)) {
      // Managers may edit non-media fields without changing another owner's
      // existing protected asset. Only an actual media replacement needs owner.
      if (!matchesPrivate(newPath, owner, listeningId, 'audio') || newUrl) {
        fail('Original private audio reference must be retained without a URL.')
      }
    } else if (newUrl !== beforeUrl) {
      // Legacy audio may be retained. New external URLs are never accepted.
      fail('Existing audio URL cannot be changed to a public URL.')
    }
  } else {
    if (actorId !== owner || !matchesPrivate(newPath, owner, listeningId, 'audio')) {
      fail('Upload private audio as the original content owner.')
    }
    if (newUrl) fail('Private audio must not include a public URL.')
  }

  const beforeMaps = isEditMode ? mapQuestions(original.parts) : new Map()
  const afterMaps = mapQuestions(next.parts)
  for (const [key, originalQ] of beforeMaps) {
    if (isPrivate(originalQ.mapImageStoragePath) && !afterMaps.has(key)) {
      fail('A protected map cannot be deleted or changed to another question type here.')
    }
  }

  for (const [key, q] of afterMaps) {
    const prior = beforeMaps.get(key)
    const oldPath = value(prior?.mapImageStoragePath)
    const oldUrl = value(prior?.mapImage)
    const updatedPath = value(q.mapImageStoragePath)
    const updatedUrl = value(q.mapImage)
    if (isEditMode && prior && updatedPath === oldPath) {
      if (isPrivate(oldPath)) {
        if (!matchesPrivate(oldPath, owner, listeningId, 'map') || updatedUrl) {
          fail('Original protected map reference must be retained without a public URL.')
        }
        continue
      }
      if (updatedUrl === oldUrl) continue
    }
    if (actorId !== owner || !matchesPrivate(updatedPath, owner, listeningId, 'map')) {
      fail('New or replaced maps must be privately uploaded by the content owner.')
    }
    if (updatedUrl && !updatedUrl.startsWith('blob:')) {
      fail('Protected map questions must not contain public image URLs.')
    }
  }
  return true
}
