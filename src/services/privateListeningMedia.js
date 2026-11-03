import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'

// Fetch only media paths selected by the backend after fresh assignment/Mock authorization.
// Never use Firebase download-token URLs as a fallback for protected objects.
const fetchPrivateChunk = httpsCallable(functions, 'getPrivateListeningMediaChunk', {
  timeout: 120000
})
const CHUNK = 2 * 1024 * 1024
const MAX_AUDIO = 30 * 1024 * 1024
const MAX_MAP = 8 * 1024 * 1024

export async function loadPrivateListeningMedia({
  listeningId, asset, mockTestId = '', questionId = '', partId = '', signal, parallelChunks = 1, progressive = false, onStreamError
}) {
  if (!listeningId || !['audio', 'map'].includes(asset)) {
    throw new Error('Invalid protected Listening media request.')
  }
  const cap = asset === 'audio' ? MAX_AUDIO : MAX_MAP
  // Keep backend authorization on every chunk. Mock audio may use
  // bounded concurrency; all other protected media remains sequential.
  const readChunk = async (offset, expected = null) => {
    if (signal?.aborted) throw new Error('Protected media request cancelled.')

    const response = await fetchPrivateChunk({
      listeningId, asset, mockTestId, questionId, partId, offset
    })

    if (signal?.aborted) throw new Error('Protected media request cancelled.')

    const data = response?.data || {}

    if (data.listeningId !== listeningId ||
        data.asset !== asset ||
        data.offset !== offset ||
        data.chunkSize !== CHUNK ||
        !Number.isSafeInteger(data.totalBytes) ||
        data.totalBytes <= 0 ||
        data.totalBytes > cap ||
        typeof data.mime !== 'string' ||
        typeof data.base64 !== 'string') {
      throw new Error('Protected media response failed integrity validation.')
    }

    if (expected &&
        (data.totalBytes !== expected.totalBytes ||
         data.mime !== expected.mime)) {
      throw new Error('Protected media file changed during download.')
    }

    if (offset >= data.totalBytes) {
      throw new Error('Protected media chunk offset is invalid.')
    }

    const wanted = Math.min(CHUNK, data.totalBytes - offset)
    const raw = atob(data.base64)

    if (raw.length !== wanted || data.chunkBytes !== wanted) {
      throw new Error('Protected media data is incomplete.')
    }

    const bytes = new Uint8Array(raw.length)

    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i)
    }

    return { bytes, totalBytes: data.totalBytes, mime: data.mime }
  }

  const first = await readChunk(0)

  // Eligible protected Listening audio may opt in to progressive streaming.
  // Non-MP3 audio and browsers lacking MSE retain the verified full-Blob path.
  if (progressive && asset === 'audio' &&
      first.mime.split(';')[0].trim().toLowerCase() === 'audio/mpeg' &&
      typeof MediaSource !== 'undefined' &&
      typeof MediaSource.isTypeSupported === 'function' &&
      MediaSource.isTypeSupported('audio/mpeg')) {
    const mediaSource = new MediaSource()
    const mediaUrl = URL.createObjectURL(mediaSource)
    const cancelled = () => Boolean(signal?.aborted)
    const cancellationError = () => new Error('Protected media request cancelled.')

    const stream = async () => {
      await new Promise((resolve, reject) => {
        if (cancelled()) return reject(cancellationError())
        if (mediaSource.readyState === 'open') return resolve()
        let timeoutId
        const cleanup = () => {
          clearTimeout(timeoutId)
          mediaSource.removeEventListener('sourceopen', opened)
          signal?.removeEventListener('abort', aborted)
        }
        const opened = () => { cleanup(); resolve() }
        const aborted = () => { cleanup(); reject(cancellationError()) }
        mediaSource.addEventListener('sourceopen', opened)
        signal?.addEventListener('abort', aborted, { once: true })
        timeoutId = setTimeout(() => {
          cleanup()
          reject(new Error('Audio streaming source did not open.'))
        }, 10000)
      })

      if (cancelled()) throw cancellationError()
      const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg')

      // A SourceBuffer has a finite quota. Never append an entire long exam
      // recording ahead of the listener. The initial chunk remains playable
      // immediately; later chunks follow the current playback position.
      const playbackTime = () => {
        if (typeof document === 'undefined') return 0
        const player = Array.from(document.querySelectorAll('audio')).find(
          element => element.currentSrc === mediaUrl || element.src === mediaUrl
        )
        const seconds = Number(player?.currentTime)
        return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0
      }

      const delay = milliseconds => new Promise((resolve, reject) => {
        if (cancelled()) return reject(cancellationError())
        let timer
        const aborted = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', aborted)
          reject(cancellationError())
        }
        timer = setTimeout(() => {
          signal?.removeEventListener('abort', aborted)
          resolve()
        }, milliseconds)
        signal?.addEventListener('abort', aborted, { once: true })
      })

      const updateBuffer = operation => new Promise((resolve, reject) => {
        if (cancelled()) return reject(cancellationError())
        const cleanup = () => {
          sourceBuffer.removeEventListener('updateend', finished)
          sourceBuffer.removeEventListener('error', failed)
          signal?.removeEventListener('abort', aborted)
        }
        const finished = () => { cleanup(); resolve() }
        const failed = () => {
          cleanup()
          reject(new Error('Protected audio media buffer failed.'))
        }
        const aborted = () => { cleanup(); reject(cancellationError()) }
        sourceBuffer.addEventListener('updateend', finished)
        sourceBuffer.addEventListener('error', failed)
        signal?.addEventListener('abort', aborted, { once: true })
        try { operation() }
        catch (error) { cleanup(); reject(error) }
      })

      const append = bytes => updateBuffer(() => sourceBuffer.appendBuffer(bytes))

      const bufferedEnd = () => {
        const ranges = sourceBuffer.buffered
        return ranges.length ? ranges.end(ranges.length - 1) : 0
      }

      const trimConsumed = async () => {
        const ranges = sourceBuffer.buffered
        if (!ranges.length) return false
        const start = ranges.start(0)
        // Keep a minute of already-played media for decoder continuity.
        const cutoff = Math.min(playbackTime() - 60, ranges.end(0) - 1)
        if (cutoff <= start + 1) return false
        await updateBuffer(() => sourceBuffer.remove(start, cutoff))
        return true
      }

      const appendWithBackpressure = async bytes => {
        // Keeping at most ~90s ahead avoids Chrome SourceBuffer quota errors.
        // It also bounds network work when preview audio has not been played.
        while (!cancelled()) {
          if (mediaSource.readyState !== 'open') {
            throw new Error('Protected audio stream was closed.')
          }
          await trimConsumed()
          if (bufferedEnd() - playbackTime() <= 90) break
          await delay(350)
        }
        if (cancelled()) throw cancellationError()
        for (;;) {
          try {
            await append(bytes)
            return
          } catch (error) {
            if (error?.name !== 'QuotaExceededError') throw error
            // A quota retry must wait for actual playback and eviction.
            await trimConsumed()
            await delay(500)
            if (cancelled()) throw cancellationError()
          }
        }
      }

      const count = Math.ceil(first.totalBytes / CHUNK)
      const limit = Math.min(3, Math.max(1, Number.isInteger(parallelChunks) ? parallelChunks : 1))
      let next = 1
      const inFlight = new Map()
      const fill = () => {
        while (!cancelled() && inFlight.size < limit && next < count) {
          const index = next++
          // Resolve failures as values so out-of-order rejections cannot escape.
          const promise = readChunk(index * CHUNK, first).then(
            result => ({ ok: true, bytes: result.bytes }),
            error => ({ ok: false, error })
          )
          inFlight.set(index, promise)
        }
      }

      // Fetch later chunks while the first one becomes playable.
      fill()
      await append(first.bytes)
      for (let index = 1; index < count; index++) {
        if (cancelled()) throw cancellationError()
        const result = await inFlight.get(index)
        inFlight.delete(index)
        fill()
        if (!result.ok) throw result.error
        await appendWithBackpressure(result.bytes)
      }
      if (cancelled()) throw cancellationError()
      if (mediaSource.readyState === 'open') mediaSource.endOfStream()
    }

    stream().catch(error => {
      if (cancelled()) return
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream('network')
      } catch (_) { /* Browser may already have closed this stream. */ }
      if (typeof onStreamError === 'function') onStreamError(error)
    })
    return mediaUrl
  }
  const chunks = new Array(Math.ceil(first.totalBytes / CHUNK))
  chunks[0] = first.bytes

  const requestedWorkers = Number.isInteger(parallelChunks)
    ? parallelChunks
    : 1

  const workerLimit = asset === 'audio'
    ? Math.min(3, Math.max(1, requestedWorkers))
    : 1

  let nextIndex = 1
  let failed = false

  const worker = async () => {
    while (!failed && nextIndex < chunks.length) {
      if (signal?.aborted) {
        failed = true
        throw new Error('Protected media request cancelled.')
      }

      const index = nextIndex++

      try {
        const part = await readChunk(index * CHUNK, first)
        chunks[index] = part.bytes
      } catch (error) {
        failed = true
        throw error
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(workerLimit, chunks.length - 1) },
      () => worker()
    )
  )

  if (signal?.aborted) throw new Error('Protected media request cancelled.')

  return URL.createObjectURL(new Blob(chunks, { type: first.mime }))
}
