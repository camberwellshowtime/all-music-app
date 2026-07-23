import { AUDIO_BASE_URL } from './config.js'
import { AUDIO_CACHE } from './cacheNames.js'

const APP_CACHE = 'music-archive-app-v1'
const KNOWN_CACHES = new Set([APP_CACHE, AUDIO_CACHE])
const AUDIO_ORIGIN = new URL(AUDIO_BASE_URL).origin

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  clients.forEach(c => c.postMessage(msg))
}

self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    await self.clients.claim()
    await broadcast({ type: 'sw-activated' })
    const names = await caches.keys()
    await Promise.all(names.filter(n => !KNOWN_CACHES.has(n)).map(n => caches.delete(n)))
  })())
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (url.origin === AUDIO_ORIGIN && !url.pathname.endsWith('.json')) {
    e.respondWith(handleAudio(e))
    return
  }
  e.respondWith(handleApp(e.request))
})

// Audio is streamed by default, not precached. The live <audio> element's
// request and the opportunistic cache-fill used to fire as two independent
// fetches of the same file — silently doubling network load on every
// not-yet-cached play, which on a marginal mobile connection is exactly the
// kind of self-inflicted contention that turns a borderline connection into
// failed reads. Now there's a single fetch: the cache-fill is derived from a
// response.clone() of the live request, so playback still starts streaming
// immediately (no added latency, which matters for the larger tracks — some
// megamixes run 15+MB) while only ever hitting the network once.
async function handleAudio(event) {
  const request = event.request
  const cacheKey = new Request(request.url)
  const cache = await caches.open(AUDIO_CACHE)
  const cached = await cache.match(cacheKey)

  if (cached) {
    const rangeHeader = request.headers.get('Range')
    return rangeHeader ? serveRange(cached, rangeHeader) : cached
  }

  const response = await fetch(request)
  if (response.ok && isFullBodyResponse(response)) {
    event.waitUntil(cacheFullResponse(cache, cacheKey, response.clone()))
  }
  return response
}

// True for a plain 200, or a 206 whose Content-Range happens to cover the
// entire resource (e.g. the element's own initial `Range: bytes=0-` probe) —
// either way there's nothing missing, so it's safe to cache as the full file.
function isFullBodyResponse(response) {
  const contentRange = response.headers.get('Content-Range')
  if (!contentRange) return response.status === 200
  const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(contentRange)
  if (!match) return false
  const [, start, end, total] = match.map(Number)
  return start === 0 && end === total - 1
}

async function cacheFullResponse(cache, cacheKey, response) {
  try {
    const buf = await response.arrayBuffer()
    await cache.put(cacheKey, new Response(buf, {
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'audio/mpeg',
        'Content-Length': String(buf.byteLength),
        'Accept-Ranges': 'bytes',
      },
    }))
  } catch {}
}

async function serveRange(response, rangeHeader) {
  const buffer = await response.arrayBuffer()
  const total  = buffer.byteLength
  // Two Range forms: `bytes=start-end` (end optional) and the suffix form
  // `bytes=-N` (last N bytes) — Android's media pipeline uses the suffix
  // form more often than desktop Chrome, e.g. when probing near EOF.
  const match       = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
  const suffixMatch = !match && /bytes=-(\d+)/.exec(rangeHeader)

  if (!match && !suffixMatch) {
    return new Response(buffer, {
      status: 200,
      headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'audio/mpeg', 'Accept-Ranges': 'bytes' },
    })
  }

  let start, end
  if (suffixMatch) {
    const suffixLength = parseInt(suffixMatch[1])
    start = Math.max(0, total - suffixLength)
    end   = total - 1
  } else {
    start = parseInt(match[1])
    end   = match[2] ? parseInt(match[2]) : total - 1
  }

  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type':   response.headers.get('Content-Type') ?? 'audio/mpeg',
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges':  'bytes',
    },
  })
}

async function handleApp(request) {
  try {
    const response = await fetch(request)
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(APP_CACHE)
      await cache.put(request, response.clone())
    }
    return response
  } catch {
    if (request.method !== 'GET') {
      return new Response('Offline', { status: 503 })
    }
    const cache  = await caches.open(APP_CACHE)
    const cached = await cache.match(request)
    if (cached) return cached
    if (request.mode === 'navigate') {
      const index = (await cache.match('/')) ?? (await cache.match('/index.html'))
      if (index) return index
    }
    return new Response('Offline', { status: 503 })
  }
}
