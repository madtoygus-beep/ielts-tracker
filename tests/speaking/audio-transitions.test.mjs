import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeakingNarrator } from '../../src/services/speakingNarrator.js'
import { wavFromBlob, wavHasSignal } from '../../src/services/speakingAudio.js'

function voiceFixture() {
  const calls = []
  class Utterance { constructor(text) { this.text = text } }
  const synthesis = { speaking: false, pending: false,
    speak(utterance) { this.speaking = true; calls.push(['speak', utterance]) },
    cancel() { this.speaking = false; this.pending = false; calls.push(['cancel']) }
  }
  return { calls, synthesis, reader: createSpeakingNarrator({ synthesis, Utterance }) }
}

test('normal question completion and later timer transitions never reset an idle speech engine', () => {
  const { calls, synthesis, reader } = voiceFixture()
  reader.stop()
  assert.equal(reader.speak('What do you enjoy learning?'), true)
  const utterance = calls[0][1]
  assert.equal(utterance.lang, 'en-GB')
  assert.equal(utterance.rate, 1)
  synthesis.speaking = false
  utterance.onend()
  reader.stop(); reader.stop(); reader.stop()
  reader.speak('How do you usually learn something new?')
  assert.deepEqual(calls.map(call => call[0]), ['speak', 'speak'])
})

test('only an unfinished owned question is cancelled, exactly once', () => {
  const { calls, reader } = voiceFixture()
  reader.speak('A long question that is still being read.')
  reader.stop(); reader.stop()
  assert.deepEqual(calls.map(call => call[0]), ['speak', 'cancel'])
})

test('a delayed event from the previous question cannot clear the next question', () => {
  const { calls, reader } = voiceFixture()
  reader.speak('First question')
  const lateEnd = calls[0][1].onend
  reader.speak('Second question')
  lateEnd()
  reader.stop()
  assert.deepEqual(calls.map(call => call[0]), ['speak', 'cancel', 'speak', 'cancel'])
})

test('queued speech is stopped before recording, while unrelated or already-ended speech is left alone', () => {
  const { calls, synthesis, reader } = voiceFixture()
  synthesis.speaking = true
  reader.stop()
  assert.equal(calls.length, 0)
  synthesis.speaking = false
  reader.speak('Queued question')
  synthesis.speaking = false; synthesis.pending = true
  reader.stop(); reader.stop()
  assert.deepEqual(calls.map(call => call[0]), ['speak', 'cancel'])
})

test('speech errors and unsupported voices do not prevent the recording flow', () => {
  const { calls, reader } = voiceFixture()
  reader.speak('Question')
  calls[0][1].onerror()
  reader.stop()
  assert.equal(calls.length, 1)
  assert.equal(createSpeakingNarrator({ synthesis: null, Utterance: null }).speak('Question'), false)
})

test('leaving immediately after speak clears an utterance even before native speaking flags update', () => {
  const { calls, synthesis, reader } = voiceFixture()
  reader.speak('Question waiting for its native start event')
  synthesis.speaking = false; synthesis.pending = false
  reader.stop(); reader.stop()
  assert.deepEqual(calls.map(call => call[0]), ['speak', 'cancel'])
})

function offlineFixture(pcm, duration = pcm.length / 16000) {
  const contexts = []
  class Offline {
    constructor(channels, frames, sampleRate) { this.channels = channels; this.frames = frames; this.sampleRate = sampleRate; this.destination = {}; contexts.push(this) }
    async decodeAudioData(bytes) { assert(bytes instanceof ArrayBuffer); return { duration } }
    createBufferSource() {
      const destination = this.destination
      return { connect(target) { assert.equal(target, destination) }, start() {} }
    }
    async startRendering() { return { getChannelData: channel => { assert.equal(channel, 0); return Float32Array.from(pcm) } } }
  }
  const previous = globalThis.window
  globalThis.window = { OfflineAudioContext: Offline,
    get AudioContext() { throw Error('A live speaker context must never be opened for conversion') },
    get webkitAudioContext() { throw Error('A live speaker context must never be opened for conversion') }
  }
  return { contexts, restore() { if (previous === undefined) delete globalThis.window; else globalThis.window = previous } }
}

test('answer conversion uses offline contexts only and preserves the server WAV contract and samples', async () => {
  const fixture = offlineFixture([-2, -1, -0.5, 0, 0.5, 1, 2])
  try {
    const wav = await wavFromBlob(new Blob(['encoded audio']))
    assert.equal(wav.type, 'audio/wav')
    const bytes = await wav.arrayBuffer(), view = new DataView(bytes)
    assert.equal(Buffer.from(bytes).toString('ascii', 0, 4), 'RIFF')
    assert.equal(Buffer.from(bytes).toString('ascii', 8, 12), 'WAVE')
    assert.equal(view.getUint32(24, true), 16000)
    assert.equal(view.getUint16(22, true), 1)
    assert.equal(view.getUint16(34, true), 16)
    assert.equal(view.getUint32(40, true), 14)
    assert.deepEqual(Array.from({ length: 7 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, -16384, 0, 16384, 32767, 32767])
    assert.equal(await wavHasSignal(wav), true)
    assert.equal(fixture.contexts.length, 2)
    assert(fixture.contexts.every(context => context.channels === 1 && context.sampleRate === 16000))
  } finally { fixture.restore() }
})

test('overlong recordings are rejected before rendering or allocating their WAV output', async () => {
  const fixture = offlineFixture([0], 131)
  try {
    await assert.rejects(wavFromBlob(new Blob(['encoded audio'])), /too long/)
    assert.equal(fixture.contexts.length, 1)
  } finally { fixture.restore() }
})
