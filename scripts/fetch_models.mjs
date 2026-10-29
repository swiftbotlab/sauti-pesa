#!/usr/bin/env node
// Download the models listed in models.json ONCE (network on), then verify size + sha256. The cross-platform twin of
// scripts/fetch_models.sh for laptops without bash/curl/bubblewrap (macOS, Windows): Node built-ins only, no
// third-party code runs. Same pins: the sha256 values come from QVAC's own model registry (@qvac/inference models.js)
// and the files from their Hugging Face origin at the exact commit QVAC pins.
//   npm run fetch-models                       the four models the app needs (~1.6 GB)
//   npm run fetch-models -- WHISPER_SMALL_Q8_0 one or more models.json keys
// Rules: https only (also for every redirect, at most 5), the start URL must be https://huggingface.co/, the file is
// written to models/<file>.part and only renamed into place when the size AND the sha256 match the pin; more bytes
// than the pin aborts at once; an interrupted download resumes (HTTP Range) on the next run.
// The two OCR files exist only in QVAC's peer-to-peer registry: their fenced downloader (scripts/fetch_models.sh,
// via scripts/fetch_registry_model.sh) is Linux-only. The app works without them (no screenshot check).
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, openSync, writeSync, closeSync, statSync, renameSync, rmSync, chmodSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DEFAULT_KEYS = ['QWEN3_1_7B_INST_Q4', 'WHISPER_SMALL_Q8_0', 'WHISPER_SMALL_SW_Q8_0', 'VAD_SILERO_5_1_2']
const MAX_REDIRECTS = 5
const IDLE_MS = 60000

/** Validate one models.json entry for a plain https download. Throws with the reason. */
export function entryFor (models, key) {
  if (!/^[A-Z0-9_]{1,60}$/.test(String(key))) throw new Error(`bad model key "${String(key).slice(0, 60)}"`)
  const m = Object.hasOwn(models, key) ? models[key] : null
  if (!m) throw new Error(`${key}: not in models.json (known: ${Object.keys(models).join(', ')})`)
  if (m.registry) throw new Error(`${key}: published only in QVAC's peer-to-peer registry; its fenced downloader is Linux-only (scripts/fetch_models.sh ${key}). The app runs without it.`)
  if (typeof m.url !== 'string' || !m.url.startsWith('https://huggingface.co/')) throw new Error(`${key}: unexpected host in ${m.url}`)
  if (typeof m.file !== 'string' || m.file !== basename(m.file) || m.file.startsWith('.') || !/^[A-Za-z0-9._-]{1,120}$/.test(m.file)) throw new Error(`${key}: bad file name`)
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error(`${key}: bad sha256 pin`)
  if (!Number.isSafeInteger(m.bytes) || m.bytes <= 0 || m.bytes > 3_000_000_000) throw new Error(`${key}: bad size pin`)
  return m
}

/** sha256 + size of a local file, or null if it is not a regular file. */
export async function hashFile (file) {
  let st
  try { st = lstatSync(file) } catch { return null }
  if (!st.isFile()) return null
  const h = createHash('sha256')
  for await (const c of createReadStream(file)) h.update(c)
  return { size: st.size, sha256: h.digest('hex') }
}

/**
 * GET with manual redirects: every hop must be https. Returns the final Response (status 200 or 206).
 * @param {string} url @param {object} headers @param {typeof fetch} fetchImpl
 */
export async function getFollowing (url, headers, fetchImpl = fetch, signal) {
  let u = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(u)
    if (parsed.protocol !== 'https:') throw new Error(`refusing a non-https URL (${parsed.protocol}//${parsed.host})`)
    if (parsed.username || parsed.password) throw new Error('refusing a URL with credentials')
    const r = await fetchImpl(u, { headers, redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location')
      try { await r.body?.cancel() } catch {}
      if (!loc) throw new Error(`redirect without a location (HTTP ${r.status})`)
      u = new URL(loc, u).href
      continue
    }
    return r
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`)
}

/**
 * Download one entry into dir/<file> (resuming dir/<file>.part), verify, rename. Returns a status line.
 * @param {{key:string, entry:object, dir:string, fetchImpl?: typeof fetch, log?: (s:string)=>void}} o
 */
export async function fetchOne ({ key, entry, dir, fetchImpl = fetch, log = console.log }) {
  const out = join(dir, entry.file)
  const part = `${out}.part`
  const have = await hashFile(out)
  if (have && have.size === entry.bytes && have.sha256 === entry.sha256) return `${key}: already present and verified`
  if (existsSync(out)) throw new Error(`${key}: ${out} exists but does not match the pin (size ${have?.size}); remove it and run again`)
  for (const f of [part]) if (existsSync(f) && !lstatSync(f).isFile()) throw new Error(`${key}: ${f} is not a regular file; refusing`)

  let h = createHash('sha256')
  let done = 0
  if (existsSync(part)) {
    const st = statSync(part)
    if (st.size > entry.bytes) rmSync(part)
    else { for await (const c of createReadStream(part)) h.update(c); done = st.size }
  }
  log(`${key}: downloading ${entry.bytes} bytes${done ? ` (resuming at ${done})` : ''}`)
  const ctrl = new AbortController()
  let idle = setTimeout(() => ctrl.abort(new Error('no data for 60 s')), IDLE_MS)
  const headers = { 'user-agent': 'sauti-pesa-fetch-models/1', ...(done ? { range: `bytes=${done}-` } : {}) }
  let fd = null
  try {
    if (done < entry.bytes) {
      const r = await getFollowing(entry.url, headers, fetchImpl, ctrl.signal)
      if (done && r.status === 200) { h = createHash('sha256'); done = 0; log(`${key}: the server ignored the resume request; starting again`) }
      if (!(r.status === 200 || (done && r.status === 206))) throw new Error(`HTTP ${r.status}`)
      fd = openSync(part, done ? 'a' : 'w', 0o644)
      for await (const chunk of r.body) {
        clearTimeout(idle)
        idle = setTimeout(() => ctrl.abort(new Error('no data for 60 s')), IDLE_MS)
        const c = Buffer.from(chunk)
        done += c.length
        if (done > entry.bytes) throw new Error(`more bytes than the pinned size ${entry.bytes}; aborted`)
        h.update(c)
        writeSync(fd, c)
      }
      closeSync(fd); fd = null
    }
  } finally {
    clearTimeout(idle)
    if (fd !== null) closeSync(fd)
  }
  if (done !== entry.bytes) throw new Error(`${key}: size ${done} != ${entry.bytes} (run again to resume)`)
  const sha = h.digest('hex')
  if (sha !== entry.sha256) { rmSync(part, { force: true }); throw new Error(`${key}: sha256 mismatch (got ${sha}); the partial file was deleted`) }
  renameSync(part, out)
  try { chmodSync(out, 0o444) } catch {}
  return `${key}: ok sha256=${sha}`
}

async function main () {
  const keys = process.argv.slice(2)
  if (keys.some((k) => k.startsWith('-'))) { console.error('usage: npm run fetch-models [-- KEY ...]   (keys from models.json)'); process.exit(2) }
  const models = JSON.parse(readFileSync(join(ROOT, 'models.json'), 'utf8'))
  const dir = join(ROOT, 'models')
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) { console.error('models/ is not a directory; refusing'); process.exit(2) }
  mkdirSync(dir, { recursive: true })
  let failed = 0
  for (const key of keys.length ? keys : DEFAULT_KEYS) {
    let entry
    try { entry = entryFor(models, key) } catch (e) { console.error(e.message); failed++; continue }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { console.log(await fetchOne({ key, entry, dir })); break } catch (e) {
        const msg = String(e?.cause?.code || e?.message || e).slice(0, 200)
        if (attempt === 3 || /sha256 mismatch|does not match the pin|not a regular file|refusing/.test(msg)) { console.error(`${key}: failed: ${msg}`); failed++; break }
        console.error(`${key}: ${msg}; retrying (${attempt}/3)`)
      }
    }
  }
  if (failed) process.exit(1)
  console.log('All requested models are on disk and verified. Now switch the network OFF and run: npm run portable -- probe')
}

const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } }
if (isMain()) await main()
