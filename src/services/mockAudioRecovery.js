// Playback progress is media time, never wall-clock exam time. A detached or
// reloading <audio> briefly reports zero; it must not erase heard progress.
const seconds = value => Number.isFinite(Number(value)) && Number(value) >= 0
  ? Number(value) : 0

export function mockAudioCheckpoint(mediaTime, heardTime, pendingTime = 0) {
  return Math.max(seconds(mediaTime), seconds(heardTime), seconds(pendingTime))
}

export function savedMockAudioPosition(saved) {
  const time = seconds(saved?.audioCurrentTime)
  const duration = seconds(saved?.audioDuration)
  // Duration is advisory: streaming metadata may describe only buffered audio.
  // Only an actual ended/locked flag proves the recording has finished.
  return { time, duration }
}

export function shouldUseProgressiveMockAudio(heardTime, pendingRestore) {
  // A resumed recording needs a complete seekable file, not a short initial
  // MSE buffer whose temporary duration could truncate the saved position.
  return seconds(heardTime) === 0 && !pendingRestore
}
