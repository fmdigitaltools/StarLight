/*
 * Cloudflare Worker that serves StarLight updates from the R2 bucket.
 *
 * To be pasted as is into the Worker editor (or deployed with
 * tools/wrangler.toml). The Worker needs these settings in its panel:
 *   - a binding to the R2 bucket named BUCKET (Settings → Bindings → R2 bucket);
 *   - optional, the secret variable KEY: when set, the Worker answers
 *     only the requests carrying the same key in the X-StarLight-Key
 *     header (the update key constant in src/shared/version.ts). When
 *     missing, access is open.
 *   - optional, the variable PREFIX (for example "starlight/") if the
 *     files live in a folder of the bucket.
 *
 * What it does:
 *   - answers only GET and HEAD, and only for the files StarLight asks for
 *     (latest.yml and the other channels, .exe installers, blockmaps, and in
 *     the catalogs/ folder the catalogs.json list and the .zip packages of
 *     the deep sky catalogs);
 *   - handles byte range requests (Range), which electron-updater uses to
 *     resume or download only the changed parts of the installer;
 *   - tells the Cloudflare and computer caches how long to keep the files:
 *     latest.yml and catalogs.json never (they change at every release),
 *     installers, blockmaps and catalog packages one year (they have the
 *     version in the name and never change).
 */

const ALLOWED_FILES = /^[A-Za-z0-9._-]+\.(yml|exe|blockmap)$/
const ALLOWED_CATALOGS = /^catalogs\/(catalogs\.json|[a-z0-9][a-z0-9._-]{0,80}\.zip)$/

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
    }

    if (env.KEY && request.headers.get('X-StarLight-Key') !== env.KEY) {
      return new Response('Access not allowed', { status: 403 })
    }

    const url = new URL(request.url)
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!ALLOWED_FILES.test(name) && !ALLOWED_CATALOGS.test(name)) return new Response('Not found', { status: 404 })
    const key = (env.PREFIX || '') + name
    const isList = name.endsWith('.json')
    const isChannel = name.endsWith('.yml') || isList

    const cacheControl = isChannel
      ? 'no-cache'
      : 'public, max-age=31536000, immutable'

    // Whole installer files go through the Cloudflare cache: the bucket is
    // read once, not at every download. The address without "?" is the key
    // (electron-updater adds cache-busting parameters).
    const cache = caches.default
    const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' })
    const wholeGet = request.method === 'GET' && !request.headers.has('Range') && !isChannel
    if (wholeGet) {
      const inCache = await cache.match(cacheKey)
      if (inCache) return inCache
    }

    const object =
      request.method === 'HEAD'
        ? await env.BUCKET.head(key)
        : await env.BUCKET.get(key, { range: request.headers, onlyIf: request.headers })
    if (object === null) return new Response('Not found', { status: 404 })

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('ETag', object.httpEtag)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', cacheControl)
    if (isList) headers.set('Content-Type', 'application/json; charset=utf-8')
    else if (isChannel) headers.set('Content-Type', 'text/yaml; charset=utf-8')
    else if (name.endsWith('.zip')) headers.set('Content-Type', 'application/zip')
    else headers.set('Content-Type', 'application/octet-stream')

    if (request.method === 'HEAD') {
      headers.set('Content-Length', String(object.size))
      return new Response(null, { status: 200, headers })
    }

    // "If-None-Match" condition met: the file has not changed.
    if (!('body' in object) || object.body === undefined) {
      return new Response(null, { status: 304, headers })
    }

    // Byte range request: partial response.
    if (object.range && request.headers.has('Range')) {
      const r = object.range
      const start = 'suffix' in r ? object.size - r.suffix : (r.offset ?? 0)
      const length = 'suffix' in r ? r.suffix : (r.length ?? object.size - start)
      headers.set('Content-Range', 'bytes ' + start + '-' + (start + length - 1) + '/' + object.size)
      headers.set('Content-Length', String(length))
      return new Response(object.body, { status: 206, headers })
    }

    headers.set('Content-Length', String(object.size))
    const response = new Response(object.body, { status: 200, headers })
    if (wholeGet) ctx.waitUntil(cache.put(cacheKey, response.clone()))
    return response
  }
}
