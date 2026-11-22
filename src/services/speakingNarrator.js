// Keep ownership of the utterance until it ends. Calling cancel() on every
// timer transition also resets the native speech engine when nothing is playing.
export function createSpeakingNarrator({
  synthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance
} = {}) {
  let current = null

  const stop = () => {
    const utterance = current
    current = null
    if (!utterance) return
    utterance.onend = null
    utterance.onerror = null
    // The retained utterance can still be queued before native state/events
    // catch up. Clear that owned work too, so it cannot start after leaving.
    synthesis.cancel()
  }

  const speak = text => {
    stop()
    if (!synthesis || !Utterance || !text?.trim()) return false
    const utterance = new Utterance(text)
    utterance.lang = 'en-GB'
    utterance.rate = 1
    const ended = () => { if (current === utterance) current = null }
    utterance.onend = ended
    utterance.onerror = ended
    current = utterance
    try { synthesis.speak(utterance); return true }
    catch { ended(); return false }
  }

  return { speak, stop }
}
