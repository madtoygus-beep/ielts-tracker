'use strict'

// Applies ONLY to institutional studentListenings projection.
// Leave the shared sanitizer unchanged for all other flows.
const { sanitizeListening } = require('./grading')

function stripInstitutionalListeningUrls(source) {
  const projected = sanitizeListening(source)
  // Never put legacy bearer URLs in a student-facing assignment projection.
  delete projected.audioUrl
  function walk(node, inMap = false, depth = 0) {
    if (!node || depth > 40) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inMap, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const isMap = inMap || node.type === 'map' || Boolean(node.mapImageStoragePath)
    for (const key of Object.keys(node)) {
      if (key === 'audioUrl' || key === 'listeningAudioUrl' ||
          (isMap && ['mapImage', 'mapImageUrl', 'image', 'imageUrl'].includes(key))) {
        delete node[key]
      } else {
        walk(node[key], isMap, depth + 1)
      }
    }
  }
  walk(projected.parts)
  walk(projected.questions)
  return projected
}

module.exports = { stripInstitutionalListeningUrls }
