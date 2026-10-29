#!/usr/bin/env node
// Host-side bridge for the local web UI. Our own code, Node built-ins only, no dependencies.
//   SAUTI_UI_TOKEN=<key> node bin/bridge.mjs     (normally started by ops/ui.sh, which makes the key, or by the
//                                                 portable launcher: npm run portable -- ui)
// What it does, and nothing else:
// - listens on 127.0.0.1 only (never 0.0.0.0); refuses other Host headers (DNS rebinding) and cross-site
//   requests (Origin check + a custom header that forces a CORS preflight, which is never answered);
// - every API call must carry this launch's random key (header x-sauti-key, compared in constant time). The key
//   reaches the page only through the #fragment of the link ops/ui.sh prints, so other local users and programs
//   that can reach 127.0.0.1 cannot drive the wallet;
// - serves a fixed list of UI files from ui/ (no paths from the request are ever joined);
// - forwards a fixed list of API routes to the offline engine's Unix socket, with bounded bodies,
//   timeouts and ONE request at a time;
// - never reads private/ and never sees the seed (signing happens inside the offline engine); requests and
//   responses carry only text, audio, screenshots (PNG/JPEG, 4 MB cap, checked by content), public addresses and
//   signed-transaction hashes;
// - the only network action: POST /api/net/{sync,broadcast} runs the separate, keyless broadcaster
//   (ops/devnet.sh for the local chain, ops/sandbox.sh online node bin/netsync.mjs for Sepolia) with
//   fixed arguments. In portable mode (SAUTI_SANDBOX=portable, set by bin/portable.mjs) there is no network action
//   at all: both routes are refused, and signed payments stay in the outbox.
import http from 'node:http'
import { readFileSync, lstatSync, existsSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, timingSafeEqual } from 'node:crypto'
import { engineSocket } from '../src/sockpath.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KEY = uiKey()
const HOST = '127.0.0.1'
const PORT = portFromEnv()
const DATA = dataRoot()
const SOCKET = socketOrExit()
const SOCK = SOCKET.path
const PORTABLE = process.env.SAUTI_SANDBOX === 'portable'
const PORTABLE_NO_NET = 'portable mode never goes online: the signed payments stay in the outbox on this device. Broadcasting is the separate online step (Linux: ops/devnet.sh broadcast, see JUDGES.md).'
const MAX_JSON = 16 * 1024
const MAX_AUDIO = 5 * 1024 * 1024
const MAX_IMAGE = 4 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg']
const UPLOAD_TIMEOUT_MS = Math.min(60000, Math.max(100, Number(process.env.SAUTI_UPLOAD_TIMEOUT_MS) || 30000)) // tests use a short one
const NETWORKS = ['devnet', 'sepolia']
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])

function portFromEnv () {
  const p = Number(process.env.SAUTI_UI_PORT || 8787)
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('SAUTI_UI_PORT must be 1024-65535')
  return p
}
// The per-launch UI key. Kept only as a hash in memory, and removed from the environment, so child processes
// (the network job) never inherit it.
function uiKey () {
  const k = process.env.SAUTI_UI_TOKEN || ''
  delete process.env.SAUTI_UI_TOKEN
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(k)) { console.error('refusing to start: no UI key (start the app with ops/ui.sh, or npm run portable -- ui)'); process.exit(2) }
  return createHash('sha256').update(k).digest()
}
function keyOk (given) {
  if (typeof given !== 'string' || given.length > 256) return false
  return timingSafeEqual(createHash('sha256').update(given).digest(), KEY)
}

function dataRoot () {
  const d = process.env.SAUTI_DATA
  if (!d) return ROOT
  const abs = resolve(ROOT, d)
  if (!abs.startsWith(join(ROOT, 'tmp') + sep)) throw new Error('SAUTI_DATA must be inside tmp/')
  return abs
}
function socketOrExit () {
  try { return engineSocket({ root: ROOT, data: DATA }) } catch (e) { console.error(`refusing to start: ${e.message}`); process.exit(2) }
}

// Fixed static files. Content types are set here, never guessed from the request.
const STATIC = {
  '/': ['ui/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['ui/index.html', 'text/html; charset=utf-8'],
  '/app.css': ['ui/app.css', 'text/css; charset=utf-8'],
  '/app.js': ['ui/app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['ui/i18n.js', 'text/javascript; charset=utf-8'],
  '/recorder-worklet.js': ['ui/recorder-worklet.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['ui/icon.svg', 'image/svg+xml'],
  '/favicon.ico': ['ui/icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['ui/manifest.webmanifest', 'application/manifest+json']
}

// API routes -> engine routes. "query" lists the parameters that are validated and passed on.
const API = {
  'GET /api/status': { to: '/v1/status', query: ['network'], timeout: 8000, light: true },
  'GET /api/outbox': { to: '/v1/outbox', query: ['network'], timeout: 8000, light: true },
  'GET /api/contacts': { to: '/v1/contacts', query: [], timeout: 8000, light: true },
  'POST /api/ask': { to: '/v1/ask', query: ['network'], timeout: 90000, max: MAX_JSON, type: 'json' },
  'POST /api/voice': { to: '/v1/voice', query: ['network', 'lang'], timeout: 120000, max: MAX_AUDIO, type: 'wav' },
  'POST /api/amend': { to: '/v1/amend', query: [], timeout: 20000, max: MAX_JSON, type: 'json' },
  'POST /api/confirm': { to: '/v1/confirm', query: [], timeout: 30000, max: MAX_JSON, type: 'json' },
  'POST /api/resign': { to: '/v1/resign', query: [], timeout: 30000, max: MAX_JSON, type: 'json' },
  'POST /api/cancel': { to: '/v1/cancel', query: [], timeout: 15000, max: MAX_JSON, type: 'json' }, // refused while a broadcast runs (busy/job check below)
  'POST /api/check': { to: '/v1/check', query: [], timeout: 90000, max: MAX_JSON, type: 'json' },
  'POST /api/read-image': { to: '/v1/read-image', query: [], timeout: 60000, max: MAX_IMAGE, type: 'image' }
}

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
  'cache-control': 'no-store'
}

const log = (...a) => console.log(new Date().toISOString(), ...a)

function send (res, status, obj, extra = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...extra })
  res.end(body)
}

function validQuery (u, names) {
  const out = new URLSearchParams()
  for (const n of names) {
    const v = u.searchParams.get(n)
    if (v === null) continue
    if (n === 'network' && !NETWORKS.includes(v)) return null
    if (n === 'lang' && !['sw', 'en'].includes(v)) return null
    out.set(n, v)
  }
  return out
}

function readBody (req, max) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0)
    if (len > max) { const e = new Error('request too large'); e.status = 413; reject(e); req.resume(); return }
    const chunks = []
    let n = 0
    // A timer for the UPLOAD only. (It used to be req.setTimeout, a socket idle timeout that stayed armed while the
    // engine worked: any on-device answer slower than 30 s was cut off and the page saw "bridge unreachable".)
    const timer = setTimeout(() => { const e = new Error('upload timed out'); e.status = 408; reject(e); req.destroy() }, UPLOAD_TIMEOUT_MS)
    req.on('data', (c) => {
      n += c.length
      if (n > max) { clearTimeout(timer); const e = new Error('request too large'); e.status = 413; reject(e); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)) })
    req.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

function socketOk () {
  if (SOCKET.pipe) return true // Windows named pipe: a random name per launch, known only to the engine and this bridge
  if (!existsSync(SOCK)) return false
  const st = lstatSync(SOCK)
  return st.isSocket() && st.uid === process.getuid() // our own engine's socket, nothing planted
}

function toEngine (method, path, body, contentType, timeout) {
  return new Promise((resolve, reject) => {
    if (!socketOk()) { const e = new Error(`engine is not running (start it with ${PORTABLE ? 'npm run portable -- ui' : 'ops/ui.sh'})`); e.status = 503; reject(e); return }
    const req = http.request({ socketPath: SOCK, method, path, headers: { 'content-type': contentType, 'content-length': body ? body.length : 0 }, timeout }, (res) => {
      const chunks = []
      let n = 0
      res.on('data', (c) => { n += c.length; if (n > 2_000_000) { req.destroy(new Error('engine response too large')) } else chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('engine timed out'), { status: 504 })))
    req.on('error', (e) => { e.status = e.status || 502; reject(e) })
    if (body) req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------- network job (the separate broadcaster)
const job = { running: false, network: null, action: null, startedAt: null, endedAt: null, code: null, lines: [] }
const clip = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').slice(0, 300)

function startNetJob (netId, action) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: join(ROOT, 'home') }
  if (process.env.SAUTI_DATA) env.SAUTI_DATA = process.env.SAUTI_DATA
  const argv = netId === 'devnet'
    ? [join(ROOT, 'ops/devnet.sh'), action]
    : [join(ROOT, 'ops/sandbox.sh'), 'online', 'node', 'bin/netsync.mjs', action, '--network', netId]
  Object.assign(job, { running: true, network: netId, action, startedAt: new Date().toISOString(), endedAt: null, code: null, lines: [] })
  const p = spawn('/bin/bash', argv, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const onData = (d) => {
    for (const line of d.toString('utf8').split('\n')) if (line.trim()) job.lines.push(clip(line))
    if (job.lines.length > 60) job.lines.splice(0, job.lines.length - 60)
  }
  p.stdout.on('data', onData)
  p.stderr.on('data', onData)
  const killer = setTimeout(() => { try { process.kill(-p.pid, 'SIGTERM') } catch {} job.lines.push('timed out after 240 s') }, 240000)
  p.on('close', (code) => {
    clearTimeout(killer)
    Object.assign(job, { running: false, code, endedAt: new Date().toISOString() })
    log(`net ${action} ${netId} exit ${code}`)
  })
}

// ---------------------------------------------------------------- server
let busy = false // one AI / wallet / network request at a time

const server = http.createServer(async (req, res) => {
  // Host + Origin: only this page, on this machine
  if (!ALLOWED_HOSTS.has(String(req.headers.host || ''))) { req.resume(); return send(res, 421, { ok: false, error: 'wrong host' }) }
  const origin = req.headers.origin
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) { req.resume(); return send(res, 403, { ok: false, error: 'cross-origin request refused' }) }
  let u
  try { u = new URL(req.url, `http://${HOST}:${PORT}`) } catch { return send(res, 400, { ok: false, error: 'bad url' }) }

  if (req.method === 'GET' && Object.hasOwn(STATIC, u.pathname)) {
    const [file, type] = STATIC[u.pathname]
    try { return send(res, 200, readFileSync(join(ROOT, file)), { 'content-type': type }) } catch { return send(res, 404, { ok: false, error: 'not found' }) }
  }
  if (!u.pathname.startsWith('/api/')) { req.resume(); return send(res, 404, { ok: false, error: 'not found' }) }
  // The launch key, in a custom header: a cross-site page cannot send it without a CORS preflight (never answered),
  // and a local program that does not have the link printed by ops/ui.sh does not know it.
  if (!keyOk(req.headers['x-sauti-key'])) { req.resume(); return send(res, 401, { ok: false, error: 'missing or wrong UI key: open the link printed by ops/ui.sh' }) }
  if (req.method !== 'GET' && origin === undefined) { req.resume(); return send(res, 403, { ok: false, error: 'origin required' }) }

  const key = `${req.method} ${u.pathname}`
  if (key === 'GET /api/net/job') return send(res, 200, { ok: true, job })
  if (key === 'POST /api/net/sync' || key === 'POST /api/net/broadcast') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) { req.resume(); return send(res, 415, { ok: false, error: 'json only' }) }
    let body
    try { body = JSON.parse((await readBody(req, 1024)).toString('utf8')) } catch (e) { return send(res, e.status || 400, { ok: false, error: e.status ? e.message : 'bad json' }) }
    if (!NETWORKS.includes(body?.network)) return send(res, 400, { ok: false, error: 'unknown network' })
    if (PORTABLE) return send(res, 409, { ok: false, error: PORTABLE_NO_NET })
    if (busy || job.running) return send(res, 429, { ok: false, error: 'busy' })
    startNetJob(body.network, key.endsWith('sync') ? 'sync' : 'broadcast')
    return send(res, 202, { ok: true, job })
  }

  const route = API[key]
  if (!route) { req.resume(); return send(res, 404, { ok: false, error: 'not found' }) }
  const q = validQuery(u, route.query)
  if (!q) { req.resume(); return send(res, 400, { ok: false, error: 'bad parameter' }) }
  const path = route.to + (q.toString() ? `?${q}` : '')
  if (route.light) {
    try { const r = await toEngine('GET', path, null, 'application/json', route.timeout); return send(res, r.status, r.body) } catch (e) { return send(res, e.status || 502, { ok: false, error: e.message }) }
  }
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim()
  if (route.type === 'json' && ct !== 'application/json') { req.resume(); return send(res, 415, { ok: false, error: 'json only' }) }
  if (route.type === 'wav' && !['audio/wav', 'audio/x-wav', 'audio/wave'].includes(ct)) { req.resume(); return send(res, 415, { ok: false, error: 'audio/wav only' }) }
  if (route.type === 'image' && !IMAGE_TYPES.includes(ct)) { req.resume(); return send(res, 415, { ok: false, error: 'image/png or image/jpeg only' }) }
  if (busy || job.running) { req.resume(); return send(res, 429, { ok: false, error: 'busy' }) }
  busy = true
  const t0 = Date.now()
  try {
    const body = await readBody(req, route.max)
    if (route.type === 'wav' && (body.length < 44 || body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WAVE')) return send(res, 415, { ok: false, error: 'audio must be a WAV file' })
    // by content, whatever the header said: PNG signature or JPEG SOI (the engine also checks the pixel size)
    const isPng = body.length > 33 && body.readUInt32BE(0) === 0x89504e47 && body.readUInt32BE(4) === 0x0d0a1a0a
    const isJpeg = body.length > 33 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
    if (route.type === 'image' && !isPng && !isJpeg) return send(res, 415, { ok: false, error: 'image must be a PNG or JPEG file' })
    const sendType = route.type === 'wav' ? 'audio/wav' : route.type === 'image' ? (isPng ? 'image/png' : 'image/jpeg') : 'application/json'
    const r = await toEngine('POST', path, body, sendType, route.timeout)
    log(key, r.status, `${Date.now() - t0}ms`)
    return send(res, r.status, r.body)
  } catch (e) {
    log(key, e.status || 502, e.message)
    return send(res, e.status || 502, { ok: false, error: e.message })
  } finally {
    busy = false
  }
})
server.requestTimeout = 150000
server.headersTimeout = 10000
server.maxHeadersCount = 40

server.listen(PORT, HOST, () => {
  const a = server.address()
  if (a.address !== HOST) { console.error('refusing: not bound to 127.0.0.1'); process.exit(2) }
  log(`Sauti Pesa UI: http://${HOST}:${PORT}  (engine ${SOCKET.pipe ? 'named pipe' : `socket ${relative(ROOT, SOCK)}`}${PORTABLE ? ', portable mode: no network actions' : ''})`)
})
