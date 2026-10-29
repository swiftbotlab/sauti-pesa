// Sauti Pesa resident ENGINE. Started by bin/serve.mjs (which first checks, with Node built-ins only, that it
// runs inside the OFFLINE sandbox with no network) inside bwrap --unshare-net:
//   ops/sandbox.sh offline node bin/serve.mjs
// or, on a laptop without bubblewrap, in the explicit portable mode with the network switched off
// (npm run portable -- ui): then the live probe runs at startup, before every AI request and before every signature.
// - keeps the QVAC speech model (whisper small + Silero VAD) and language model (Qwen3-1.7B) loaded, with the
//   fixed prompt prefixes held in QVAC's KV cache, so a request costs ~1-2 s ASR + ~1-1.5 s LLM;
// - holds the wallet: the seed is read from private/ only here and never leaves this process;
// - answers a small JSON API over a Unix socket (tmp/run/engine.sock, mode 0600). It has no network at all:
//   the host-side bridge (bin/bridge.mjs) forwards 127.0.0.1:8787 to this socket (a random named pipe on Windows);
// - reads screenshots for "Check a message" with QVAC OCR (loaded per screenshot, then unloaded);
// - refuses to start, and refuses to sign, when the internet is reachable (src/gate.js).
// One request is processed at a time; bodies, text and audio are size-capped; sessions expire.
import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, unlinkSync, lstatSync, rmSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { close } from '@qvac/sdk'
import { openWallet, walletExists } from './wallet.js'
import { loadContacts } from './contacts.js'
import { Store } from './queue.js'
import { network, NETWORKS } from './networks.js'
import { LocalLLM } from './llm.js'
import { LocalASR, MAX_AUDIO_BYTES, asrLabel } from './asr.js'
import { LocalOCR, MAX_IMAGE_BYTES, inspectImage } from './ocr.js'
import { analyzeRequest, amendAnalysis, confirmAndQueue, analyzeMessage, resignEntry } from './pipeline.js'
import { analysisView, outboxView, contactView } from './view.js'
import { cancelEntry, holdMinutesFrom } from './undo.js'
import { networkProof } from './offline.js'
import { checkGate } from './gate.js'
import { engineSocket } from './sockpath.js'
import { missingModelMessage, fetchCommand } from './setup_hint.js'
import { reasonText } from './i18n.js'
import { fromUnits } from './amount.js'
import { currentRssMb } from './procmem.js'
import { clean, shortAddr } from './text.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // project root (this file is in src/)
const CFG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const DATA = dataRoot()
const PRIV = join(DATA, 'private')
const WALLET = join(PRIV, 'wallet.json')
const CONTACTS = join(PRIV, 'contacts.json')
const RUN = join(DATA === ROOT ? join(ROOT, 'tmp') : DATA, 'run')
const SOCKET = socketOrExit() // Unix socket in RUN (a named pipe on Windows, portable mode only)
const SOCK = SOCKET.path
const PORTABLE = process.env.SAUTI_SANDBOX === 'portable'
const UPLOADS = join(RUN, 'uploads')
const MAX_JSON = 16 * 1024
const SESSION_TTL_MS = 15 * 60 * 1000
const MAX_SESSIONS = 32
const LIMITS = { perTx: '100', perDay: '300', newRecipientMax: '20', retypeAbove: '50', ...(CFG.limits || {}) }
const HOLD_MINUTES = holdMinutesFrom(CFG) // undo window for flagged payments (src/undo.js); 0 = off
const OCR_MISSING_PORTABLE = 'OCR model missing: the screenshot check needs OCR_LATIN + OCR_CRAFT, which QVAC publishes only in its own peer-to-peer registry; our fenced downloader for them is Linux-only (scripts/fetch_models.sh OCR_LATIN OCR_CRAFT). Typed and pasted messages are checked without it.'

function dataRoot () {
  const d = process.env.SAUTI_DATA
  if (!d) return ROOT
  const abs = resolve(ROOT, d)
  if (!abs.startsWith(join(ROOT, 'tmp') + sep)) throw new Error('SAUTI_DATA must be inside tmp/')
  return abs
}

function socketOrExit () {
  try { return engineSocket({ root: ROOT, data: DATA }) } catch (e) { console.error(`engine failed: ${e.message}`); process.exit(2) }
}

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---------------------------------------------------------------- state
const engine = { stage: 'starting', ready: false, startedAt: new Date().toISOString(), loadMs: {}, warmMs: null, error: null }
let asr = null
let llm = null
let address = null
let proofCache = null
const sessions = new Map() // sid -> { a, network, created, used }

function modelPath (rel) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) throw new Error(missingModelMessage(ROOT, rel))
  return realpathSync(p)
}

// Per-language speech models: Swahili uses the Swahili fine-tune of Whisper small when it is on disk
// (config.models.asr_sw), every other language the multilingual Whisper small (config.models.asr). Only one of them
// is in RAM at a time (LocalASR single mode swaps them when the language changes).
function asrModelPaths () {
  const rel = CFG.models.asr_sw
  if (!rel) return {}
  if (!existsSync(join(ROOT, rel))) { log(`Swahili speech model ${rel} is missing: Swahili uses ${CFG.models.asr} (download it once, with the internet on: ${fetchCommand(['WHISPER_SMALL_SW_Q8_0'])})`); return {} }
  return { sw: modelPath(rel) }
}

function asrModelsText () {
  if (!asr) return asrLabel(CFG.models.asr)
  const sw = asrLabel(asr.pathFor('sw')); const en = asrLabel(asr.pathFor('en'))
  return sw === en ? sw : `${sw} (sw) · ${en} (en)`
}

async function proof (maxAgeMs = 5000) {
  if (!proofCache || Date.now() - Date.parse(proofCache.at) > maxAgeMs) proofCache = await networkProof()
  return proofCache
}

// The run gate (src/gate.js) with a FRESH probe: right before every signature (both modes), and in portable mode
// before every AI request too (there is no sandbox there, so the person's switched-off network is re-checked).
async function gate (action) {
  const g = await checkGate({ action, launcher: 'node bin/serve.mjs', probe: () => proof(0) })
  if (!g.ok) { log(`${action} refused: ${g.message}`); throw httpError(423, g.message) }
}

// one request at a time (the models, the wallet and the outbox are single-user state)
let tail = Promise.resolve()
function serial (fn) {
  const run = tail.then(fn, fn)
  tail = run.catch(() => {})
  return run
}

function netOf (q) {
  const id = q.get('network') || CFG.network
  if (!Object.hasOwn(NETWORKS, id)) throw httpError(400, 'unknown network')
  return id
}
const langOf = (v) => (['sw', 'en'].includes(v) ? v : 'sw')
const storeOf = (netId) => new Store(join(DATA, 'queue'), netId)
const tokenOf = (netId, store) => network(netId).token.address || store.state().tokenAddress || null

function httpError (status, message) { const e = new Error(message); e.status = status; return e }

function pruneSessions () {
  const now = Date.now()
  for (const [k, s] of sessions) if (now - s.created > SESSION_TTL_MS || s.used) sessions.delete(k)
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
}

function ctxFor (netId) {
  const store = storeOf(netId)
  const contacts = loadContacts(CONTACTS)
  return { store, contacts, ownAddress: address, tokenAddress: tokenOf(netId, store), limits: LIMITS }
}

function viewFor (a, ctx, extra = {}) {
  const st = ctx.store.state()
  return analysisView(a, { contacts: ctx.contacts, limits: LIMITS, balanceUnits: st.balance?.units ?? null, ...extra })
}

function llmStep () {
  const s = llm.stats.at(-1) || {}
  return { prompt_tokens: s.promptTokens ?? null, cached_tokens: s.cacheTokens ?? null, generated_tokens: s.generatedTokens ?? null }
}

// ---------------------------------------------------------------- handlers
async function startAnalysis ({ text, netId, uiLang }) {
  const ctx = ctxFor(netId)
  if (!address) throw httpError(409, 'no wallet yet: run "node bin/sauti.mjs wallet init" in the offline sandbox')
  const t0 = Date.now()
  const a = await analyzeRequest({ text, llm, ...ctx })
  const steps = []
  steps.push({ id: 'llm', model: 'Qwen3-1.7B Q4_0 (QVAC, KV-cached prompt)', ms: a.llmMs, ...llmStep() })
  steps.push({ id: 'checks', ms: Math.max(0, Date.now() - t0 - (a.llmMs || 0)), count: 6 })
  if (!a.ok) return { ok: false, transcript: a.transcript, errors: a.errors, steps }
  pruneSessions()
  const sid = randomBytes(16).toString('hex')
  sessions.set(sid, { a, network: netId, created: Date.now(), used: false })
  const view = viewFor(a, ctx)
  if (view.action === 'balance') view.balance = balanceInfo(ctx.store)
  return { ok: true, sid, network: netId, view, steps, uiLang }
}

function balanceInfo (store) {
  const s = store.state()
  return { usdt: s.balance ? fromUnits(s.balance.units) : null, at: s.balance?.at || null }
}

async function onAsk (body, q) {
  const text = clean(String(body.text ?? ''), 1000)
  if (!text) throw httpError(400, 'empty request')
  return startAnalysis({ text, netId: netOf(q), uiLang: langOf(body.lang) })
}

async function onVoice (buf, q) {
  const lang = q.get('lang') === 'en' ? 'en' : 'sw'
  const netId = netOf(q)
  mkdirSync(UPLOADS, { recursive: true, mode: 0o700 })
  const f = join(UPLOADS, `${randomUUID()}.wav`)
  writeFileSync(f, buf, { mode: 0o600, flag: 'wx' })
  let r
  try {
    r = await asr.transcribe(f, lang) // inspectWav() checks the CONTENT (RIFF/WAVE, PCM16, <= 30 s) first
  } catch (e) {
    throw httpError(400, String(e.message).slice(0, 160))
  } finally {
    rmSync(f, { force: true })
  }
  const step = { id: 'asr', model: `${asrLabel(r.model)} + Silero VAD (QVAC)`, asr_model: asrLabel(r.model), ms: r.ms, audio_s: r.seconds, lang: r.lang, input_gain_db: r.gain?.gain_db ?? 0 }
  if (r.gain?.applied) log(`voice note: quiet input (${r.gain.rms_dbfs} dBFS RMS, peak ${r.gain.peak_dbfs} dBFS) raised by ${r.gain.gain_db} dB`)
  if (!r.text || r.text.length < 2) return { ok: false, transcript: '', errors: ['no speech heard'], steps: [step] }
  // Speech -> text only. The page shows the words at once and then sends them to /v1/ask like typed text,
  // so the person sees real progress (and can see exactly what the device heard).
  return { ok: true, transcript: r.text, lang: r.lang, network: netId, steps: [step] }
}

// "Check a message" from a screenshot: QVAC OCR turns the image into text, nothing more. Like voice, the page shows
// the text at once and then sends it to /v1/check exactly like pasted text, so the same checks decide.
// The OCR model is loaded for each screenshot and unloaded right after: the resident engine's memory does not grow.
// While it reads, the speech model is unloaded too (it reloads on the next voice note, about 1 s), so speech and OCR
// are never in memory together: measured, that keeps the whole app under a 3 GB cap (README, "Runs in 3 GB").
async function onReadImage (buf) {
  let info
  try { info = inspectImage(buf) } catch (e) { throw httpError(400, String(e.message).slice(0, 160)) } // by CONTENT: PNG/JPEG, size caps
  const files = [CFG.models.ocr, CFG.models.ocr_detector].map((rel) => join(ROOT, rel || ''))
  if (!CFG.models.ocr || !files.every((f) => existsSync(f))) throw httpError(503, PORTABLE ? OCR_MISSING_PORTABLE : 'OCR model missing: run scripts/fetch_models.sh OCR_LATIN OCR_CRAFT once (online)')
  const reader = new LocalOCR({ modelPath: realpathSync(files[0]), detectorPath: realpathSync(files[1]), threads: CFG.ocr_threads || 4 })
  let r; let loadMs
  await asr.unload() // LocalASR (single mode) loads itself again on the next transcription
  try {
    loadMs = await reader.load()
    try { r = await reader.read(buf) } catch (e) { log('ocr read failed:', String(e.message).slice(0, 120)); throw httpError(400, 'could not read text from this image') }
  } finally {
    await reader.unload().catch(() => {})
  }
  const step = { id: 'ocr', model: 'QVAC OCR: CRAFT detector + latin_g2 (OCR_CRAFT, OCR_LATIN)', ms: r.ms, load_ms: loadMs, blocks: r.blocks, image: `${info.width}x${info.height} ${info.type}` }
  if (!r.text) return { ok: false, text: '', errors: ['no text found in the image'], steps: [step] }
  return { ok: true, text: r.text, steps: [step] }
}

async function onAmend (body) {
  const s = sessions.get(String(body.sid || ''))
  if (!s || s.used || Date.now() - s.created > SESSION_TTL_MS) throw httpError(410, 'this request expired; please start again')
  const ctx = ctxFor(s.network)
  const t0 = Date.now()
  const change = {}
  if (body.amount !== undefined) change.amount = String(body.amount).slice(0, 20)
  if (body.contactId !== undefined) change.contactId = String(body.contactId).slice(0, 40)
  let a
  try { a = amendAnalysis(s.a, change, ctx) } catch (e) { throw httpError(400, e.message) }
  s.a = a
  return { ok: true, sid: body.sid, network: s.network, view: viewFor(a, ctx), steps: [{ id: 'checks', ms: Date.now() - t0, count: 6, amended: true }] }
}

async function onConfirm (body) {
  const sid = String(body.sid || '')
  const s = sessions.get(sid)
  if (!s || s.used || Date.now() - s.created > SESSION_TTL_MS) throw httpError(410, 'this request expired; please start again')
  if (s.a.decision === 'blocked') throw httpError(409, 'this payment is blocked and cannot be confirmed')
  const netId = s.network
  const net = network(netId)
  const ctx = ctxFor(netId)
  // the analysis was made a few minutes ago: re-run the code checks on the CURRENT state (limits, outbox)
  const fresh = amendAnalysis(s.a, {}, ctx)
  if (fresh.decision === 'blocked') throw httpError(409, 'the checks changed since this was shown; please start again')
  await gate('sign')
  const t0 = Date.now()
  const wallet = await openWallet(WALLET, { chainId: net.chainId })
  try {
    const q = await confirmAndQueue({ analysis: fresh, wallet, store: ctx.store, networkId: netId, tokenAddress: ctx.tokenAddress, retypedAmount: body.retype === undefined ? undefined : String(body.retype).slice(0, 20), holdMinutes: HOLD_MINUTES })
    s.used = true
    sessions.delete(sid)
    return { ok: true, network: netId, queued: outboxView(q, net, ctx.store), steps: [{ id: 'sign', ms: Date.now() - t0, policy: 'WDK policy: only this transfer (token, recipient, amount, chain, fee cap), one signature' }] }
  } catch (e) {
    throw httpError(400, String(e.message).slice(0, 200))
  } finally {
    wallet.dispose()
  }
}

async function onResign (body, q) {
  const netId = netOf(new URLSearchParams({ network: String(body.network || '') }))
  if (body.confirm !== true) throw httpError(400, 'the person must confirm the re-signature')
  const id = String(body.id || '')
  if (!/^[0-9a-f-]{36}$/.test(id)) throw httpError(400, 'bad id')
  const net = network(netId)
  const store = storeOf(netId)
  await gate('sign')
  const t0 = Date.now()
  const wallet = await openWallet(WALLET, { chainId: net.chainId })
  try {
    const e = await resignEntry({ entryId: id, wallet, store, networkId: netId, chainId: net.chainId })
    return { ok: true, network: netId, entry: outboxView(e, net, store), steps: [{ id: 'sign', ms: Date.now() - t0, policy: 'WDK policy: re-sign the same transfer with a new nonce' }] }
  } catch (e) {
    throw httpError(400, String(e.message).slice(0, 200))
  } finally {
    wallet.dispose()
  }
}

// Undo window: cancel a queued payment that was never handed to the network (src/undo.js). No key is needed: the
// signed bytes are deleted, nothing is signed. Newer queued payments come back as "needs_resign".
async function onCancel (body) {
  const netId = netOf(new URLSearchParams({ network: String(body.network || '') }))
  if (body.confirm !== true) throw httpError(400, 'the person must confirm the cancel')
  const id = String(body.id || '')
  if (!/^[0-9a-f-]{36}$/.test(id)) throw httpError(400, 'bad id')
  const net = network(netId)
  const store = storeOf(netId)
  let r
  try { r = cancelEntry({ store, id, chainId: net.chainId }) } catch (e) { throw httpError(409, String(e.message).slice(0, 200)) }
  log(`outbox: cancelled ${id.slice(0, 8)} (nonce ${r.entry.nonce})${r.resign.length ? `; ${r.resign.length} newer payment(s) need re-signing` : ''}`)
  return { ok: true, network: netId, entry: outboxView(r.entry, net, store), resign: r.resign.map((e) => outboxView(e, net, store)) }
}

async function onCheck (body) {
  const text = clean(String(body.text ?? ''), 2000)
  if (!text) throw httpError(400, 'empty message')
  const netId = Object.hasOwn(NETWORKS, body.network) ? body.network : CFG.network
  const contacts = loadContacts(CONTACTS)
  const t0 = Date.now()
  const r = await analyzeMessage({ text, llm, contacts, history: storeOf(netId).history() })
  const addresses = r.addresses.map((x) => ({
    address: x.address,
    short: shortAddr(x.address),
    knownAs: x.knownAs,
    issue: x.issue ? { code: x.issue, sw: reasonText({ code: x.issue }, 'sw'), en: reasonText({ code: x.issue }, 'en') } : null,
    looksLike: x.looksLike.map((l) => ({
      name: l.name, short: shortAddr(l.address), level: l.level,
      sw: reasonText({ code: 'lookalike_address', similarTo: l.name, similarAddress: l.address }, 'sw'),
      en: reasonText({ code: 'lookalike_address', similarTo: l.name, similarAddress: l.address }, 'en')
    }))
  }))
  return {
    ok: true,
    view: {
      risk: r.risk,
      lang: r.lang,
      headline: r.headline,
      flags: r.flags.filter((f) => f.source !== 'model').map((f) => ({ id: f.id, evidence: f.evidence, sw: f.sw, en: f.en })),
      aiFlags: r.flags.filter((f) => f.source === 'model').map((f) => f.id),
      addresses,
      aiNote: r.aiNote
    },
    steps: [{ id: 'llm', model: 'Qwen3-1.7B Q4_0 (QVAC, KV-cached prompt)', ms: r.llmMs, ...llmStep() }, { id: 'checks', ms: Math.max(0, Date.now() - t0 - r.llmMs), count: 11 }]
  }
}

async function onStatus (q) {
  const netId = netOf(q)
  const net = network(netId)
  const store = storeOf(netId)
  const s = store.state()
  const counts = {}
  for (const e of store.list()) counts[e.status] = (counts[e.status] || 0) + 1
  const rss = currentRssMb()
  return {
    ok: true,
    engine: {
      ready: engine.ready,
      stage: engine.stage,
      error: engine.error,
      startedAt: engine.startedAt,
      loadMs: engine.loadMs,
      warmMs: engine.warmMs,
      models: { asr: asrModelsText(), vad: 'Silero VAD 5.1.2 (VAD_SILERO_5_1_2)', llm: 'Qwen3-1.7B Q4_0 (QWEN3_1_7B_INST_Q4)', ocr: 'OCR_LATIN + OCR_CRAFT (loaded per screenshot)', sdk: '@qvac/sdk 0.22.0' },
      rssMb: Object.values(rss).reduce((x, y) => x + y, 0)
    },
    net: await proof(),
    wallet: address ? { address, short: shortAddr(address) } : null,
    network: { id: netId, name: net.name, chainId: net.chainId, explorer: net.explorer, testnet: true },
    chain: {
      usdt: s.balance ? fromUnits(s.balance.units) : null,
      native: s.native ? fromUnits(s.native.wei, 18) : null,
      nativeSymbol: net.nativeSymbol,
      nonce: Number.isInteger(s.nonce) ? s.nonce : null,
      syncedAt: s.nonceAt || null
    },
    outbox: counts,
    limits: LIMITS
  }
}

function onOutbox (q) {
  const netId = netOf(q)
  const net = network(netId)
  const store = storeOf(netId)
  return { ok: true, network: netId, holdMinutes: HOLD_MINUTES, entries: store.list().map((e) => outboxView(e, net, store)).reverse() }
}

function onContacts () {
  return { ok: true, contacts: loadContacts(CONTACTS).map(contactView) }
}

// ---------------------------------------------------------------- HTTP over the Unix socket
function readBody (req, max) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0)
    if (len > max) { reject(httpError(413, 'request too large')); req.resume(); return }
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > max) { reject(httpError(413, 'request too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseJson (buf) {
  try {
    const o = JSON.parse(buf.toString('utf8') || '{}')
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error()
    return o
  } catch { throw httpError(400, 'body must be a JSON object') }
}

const ROUTES = {
  'GET /v1/status': { fn: (r) => onStatus(r.q), light: true },
  'GET /v1/outbox': { fn: (r) => onOutbox(r.q), light: true },
  'GET /v1/contacts': { fn: () => onContacts(), light: true },
  'POST /v1/ask': { fn: async (r) => onAsk(parseJson(await readBody(r.req, MAX_JSON)), r.q), ai: true },
  'POST /v1/voice': { fn: async (r) => onVoice(await readBody(r.req, MAX_AUDIO_BYTES), r.q), ai: true, audio: true },
  'POST /v1/amend': { fn: async (r) => onAmend(parseJson(await readBody(r.req, MAX_JSON))), ai: false },
  'POST /v1/confirm': { fn: async (r) => onConfirm(parseJson(await readBody(r.req, MAX_JSON))), ai: false, signs: true },
  'POST /v1/resign': { fn: async (r) => onResign(parseJson(await readBody(r.req, MAX_JSON)), r.q), ai: false, signs: true },
  'POST /v1/cancel': { fn: async (r) => onCancel(parseJson(await readBody(r.req, MAX_JSON))), ai: false },
  'POST /v1/check': { fn: async (r) => onCheck(parseJson(await readBody(r.req, MAX_JSON))), ai: true },
  'POST /v1/read-image': { fn: async (r) => onReadImage(await readBody(r.req, MAX_IMAGE_BYTES)), ai: true, image: true }
}

function send (res, status, obj) {
  const body = JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now()
  let u
  try { u = new URL(req.url, 'http://engine') } catch { return send(res, 400, { ok: false, error: 'bad url' }) }
  const key = `${req.method} ${u.pathname}`
  const route = ROUTES[key]
  if (!route) { req.resume(); return send(res, 404, { ok: false, error: 'not found' }) }
  if (!route.light && !engine.ready) { req.resume(); return send(res, 503, { ok: false, error: `engine is ${engine.stage}` }) }
  if (route.audio && !/^audio\/(wav|x-wav|wave)$/.test(String(req.headers['content-type'] || '').split(';')[0].trim())) { req.resume(); return send(res, 415, { ok: false, error: 'audio must be sent as audio/wav' }) }
  if (route.image && !/^image\/(png|jpeg)$/.test(String(req.headers['content-type'] || '').split(';')[0].trim())) { req.resume(); return send(res, 415, { ok: false, error: 'image must be sent as image/png or image/jpeg' }) }
  try {
    const out = route.light
      ? await route.fn({ req, q: u.searchParams })
      : await serial(async () => { if (PORTABLE && !route.signs) await gate('run'); return route.fn({ req, q: u.searchParams }) }) // signing routes: gate('sign') inside
    out.ms = Date.now() - t0
    send(res, 200, out)
    if (!route.light) log(key, 200, `${out.ms}ms`, out.view?.decision || out.view?.risk || (out.queued ? 'queued' : ''))
  } catch (e) {
    const status = e.status || 500
    if (status === 500) log(key, 500, String(e.stack || e).slice(0, 400))
    else log(key, status, String(e.message).slice(0, 120))
    send(res, status, { ok: false, error: status === 500 ? 'internal error' : String(e.message).slice(0, 200) })
  }
})
server.requestTimeout = 120000
server.headersTimeout = 10000
server.maxHeadersCount = 30

async function start () {
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  // Hard guard: this process holds the AI and the keys. It only runs in the offline sandbox (or the explicit portable
  // mode) with the internet unreachable, checked by a live probe (src/gate.js).
  const g = await checkGate({ launcher: 'node bin/serve.mjs', probe: () => proof(0) })
  if (!g.ok) { console.error(g.message); process.exit(2) }
  const p = g.proof
  mkdirSync(RUN, { recursive: true, mode: 0o700 })
  chmodSync(RUN, 0o700)
  // voice notes left over from an engine that was killed mid-request: never kept, never reused
  rmSync(UPLOADS, { recursive: true, force: true })
  mkdirSync(UPLOADS, { mode: 0o700 })
  if (!SOCKET.pipe && existsSync(SOCK)) {
    if (!lstatSync(SOCK).isSocket()) throw new Error(`${SOCK} exists and is not a socket`)
    unlinkSync(SOCK)
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(SOCK, resolve) })
  if (!SOCKET.pipe) chmodSync(SOCK, 0o600)
  const where = SOCKET.pipe ? 'a named pipe' : relative(ROOT, SOCK)
  const mode = PORTABLE ? `portable mode: no sandbox, the probe re-runs before every request and signature; interfaces ${p.interfaces.join(',')}` : `${p.interfaces.join(',')} only`
  log(`listening on ${where} (network: OFF, verified: ${mode}; tcp ${p.tcp_ipv4.error}; dns ${p.dns.error})`)

  if (walletExists(WALLET)) {
    const w = await openWallet(WALLET, { chainId: 1 })
    address = await w.address()
    w.dispose()
    for (const id of Object.keys(NETWORKS)) storeOf(id).saveState({ address }) // public address only
  }
  const names = existsSync(CONTACTS) ? loadContacts(CONTACTS).map((c) => c.name) : []
  engine.stage = 'loading speech model'
  let t = Date.now()
  asr = new LocalASR({ modelPath: modelPath(CFG.models.asr), modelPaths: asrModelPaths(), vadPath: modelPath(CFG.models.vad), threads: CFG.asr_threads || 4, names, single: true, tmpDir: UPLOADS }) // a level-raised copy of a quiet clip lives in uploads/ for the call
  await asr.prepare('sw')
  engine.loadMs.asr = Date.now() - t
  // Warm the speech path once (the first transcription pays one-off setup), so the person's first voice note is
  // as fast as the next ones. Optional: a short clip from config.json, skipped if the file is not there.
  const warmClip = typeof CFG.asr_warmup === 'string' ? resolve(ROOT, CFG.asr_warmup) : null
  if (warmClip && warmClip.startsWith(ROOT) && existsSync(warmClip)) {
    engine.stage = 'warming the speech model'
    t = Date.now()
    try { await asr.transcribe(warmClip, 'sw'); engine.loadMs.asrWarm = Date.now() - t } catch (e) { log(`speech warm-up skipped: ${String(e.message).slice(0, 80)}`) }
  }
  engine.stage = 'loading language model'
  t = Date.now()
  llm = new LocalLLM({ modelPath: modelPath(CFG.models.llm), threads: CFG.llm_threads || undefined, cache: true })
  await llm.load()
  engine.loadMs.llm = Date.now() - t
  engine.stage = 'warming the prompt cache'
  engine.warmMs = await llm.warm()
  engine.stage = 'ready'
  engine.ready = true
  log(`ready: asr ${engine.loadMs.asr} ms (+${engine.loadMs.asrWarm ?? 0} ms warm-up), llm ${engine.loadMs.llm} ms, prompt-cache warm-up ${engine.warmMs} ms`)
}

async function shutdown (sig) {
  log(`${sig}: shutting down`)
  server.close()
  try { await asr?.unload() } catch {}
  try { await llm?.unload() } catch {}
  try { await close() } catch {}
  if (!SOCKET.pipe) try { unlinkSync(SOCK) } catch {}
  process.exit(0)
}

export function runEngine () {
  return start().catch(async (e) => {
  engine.stage = 'failed'
  engine.error = String(e.message).slice(0, 200)
  console.error(`engine failed: ${e.message}`)
  try { await close() } catch {}
  if (!SOCKET.pipe) try { unlinkSync(SOCK) } catch {}
  process.exit(1)
  })
}
