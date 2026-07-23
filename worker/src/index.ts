export interface Env {
  AUDIO_BUCKET: R2Bucket
}

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days — archive audio never changes

// The app is served from a different origin (localhost in dev, Netlify in
// prod) than this Worker, so every response needs CORS headers. Range is a
// non-simple header, which makes browsers preflight audio seek requests.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag',
  'Access-Control-Max-Age': '86400',
}

function withCors(headers: HeadersInit): Headers {
  const h = new Headers(headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v)
  return h
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: withCors({}) })
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: withCors({}) })
      }

      const url = new URL(request.url)
      const key = decodeURIComponent(url.pathname.slice(1))
      if (!key) return new Response('Not found', { status: 404, headers: withCors({}) })

      // catalog.json is meant to be updated by re-upload without a Worker
      // redeploy — never cache it, always read straight from R2.
      if (key.endsWith('.json')) {
        const object = await env.AUDIO_BUCKET.get(key)
        if (!object) return new Response('Not found', { status: 404, headers: withCors({}) })
        return new Response(request.method === 'HEAD' ? null : object.body, {
          headers: withCors({
            'Content-Type': object.httpMetadata?.contentType ?? 'application/json',
            'Content-Length': String(object.size),
            'Cache-Control': 'no-cache',
            'ETag': object.httpEtag,
          }),
        })
      }

      // Audio: work in plain ArrayBuffers rather than teed/cloned Response
      // streams — R2 files here are small enough (a few MB) to buffer in
      // memory, and it sidesteps a real bug where concurrent range/full
      // requests for the same not-yet-cached key (which is exactly what
      // browsers' <audio> elements fire on first load) raced on a cloned
      // ReadableStream and intermittently threw, surfacing as a bare 503.
      const cache = caches.default
      const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' })
      const cached = await cache.match(cacheKey).catch(() => null)

      let buf: ArrayBuffer
      let contentType: string
      let etag: string

      if (cached) {
        buf = await cached.arrayBuffer()
        contentType = cached.headers.get('Content-Type') ?? 'audio/mpeg'
        etag = cached.headers.get('ETag') ?? ''
      } else {
        const object = await env.AUDIO_BUCKET.get(key)
        if (!object) return new Response('Not found', { status: 404, headers: withCors({}) })
        buf = await object.arrayBuffer()
        contentType = object.httpMetadata?.contentType ?? 'audio/mpeg'
        etag = object.httpEtag

        const toCache = new Response(buf, {
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(buf.byteLength),
            'Accept-Ranges': 'bytes',
            'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
            'ETag': etag,
          },
        })
        ctx.waitUntil(cache.put(cacheKey, toCache).catch(() => {}))
      }

      const size = buf.byteLength
      const range = request.headers.get('Range')
      // Two Range forms: `bytes=start-end` (end optional) and the suffix form
      // `bytes=-N` (last N bytes) — Android's media pipeline uses the suffix
      // form more often than desktop Chrome, e.g. when probing near EOF.
      const match = range ? /bytes=(\d+)-(\d*)/.exec(range) : null
      const suffixMatch = !match && range ? /bytes=-(\d+)/.exec(range) : null

      if (!range || (!match && !suffixMatch)) {
        return new Response(request.method === 'HEAD' ? null : buf, {
          headers: withCors({
            'Content-Type': contentType,
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
            'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
            'ETag': etag,
          }),
        })
      }

      let start: number
      let end: number
      if (suffixMatch) {
        const suffixLength = Number(suffixMatch[1])
        start = Math.max(0, size - suffixLength)
        end = size - 1
      } else {
        start = Number(match![1])
        end = match![2] ? Number(match![2]) : size - 1
      }

      return new Response(request.method === 'HEAD' ? null : buf.slice(start, end + 1), {
        status: 206,
        headers: withCors({
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
        }),
      })
    } catch (err) {
      return new Response(`Worker error: ${err instanceof Error ? err.message : String(err)}`, {
        status: 500,
        headers: withCors({}),
      })
    }
  },
}
