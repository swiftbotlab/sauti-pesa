// Bridge timeouts: the real bin/bridge.mjs against a fake engine socket (no models, no network beyond 127.0.0.1).
// Found in a demo take on a busy CPU: an on-device answer that took 33 s never reached the page, because the
// bridge's upload timeout was a SOCKET idle timeout that stayed armed while the engine was working.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KEY = randomBytes(32).toString('base64url') // this test's UI key
const DATA = join(ROOT, 'tmp', `bridge-test-${process.pid}`)
const PORT = 20000 + (process.pid % 20000)
const B = `http://127.0.0.1:${PORT}`

function fakeEngine (delayMs) {
  mkdirSync(join(DATA, 'run'), { recursive: true, mode: 0o700 })
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => setTimeout(() => {
      const b = JSON.stringify({ ok: true, view: { decision: 'confirm' } })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) })
      res.end(b)
    }, delayMs))
  })
  return new Promise((resolve) => srv.listen(join(DATA, 'run', 'engine.sock'), () => resolve(srv)))
}

function startBridge () {
  const p = spawn(process.execPath, [join(ROOT, 'bin/bridge.mjs')], {
    env: { PATH: process.env.PATH, SAUTI_DATA: DATA, SAUTI_UI_PORT: String(PORT), SAUTI_UPLOAD_TIMEOUT_MS: '800', SAUTI_UI_TOKEN: KEY },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge did not start')), 8000)
    p.stdout.on('data', (d) => { if (String(d).includes('Sauti Pesa UI')) { clearTimeout(t); resolve(p) } })
    p.on('exit', (c) => reject(new Error(`bridge exited ${c}`)))
  })
}

test('bridge: a slow on-device answer is not cut off by the upload timeout', async () => {
  const eng = await fakeEngine(2500) // engine works 3x longer than the upload timeout
  const br = await startBridge()
  try {
    const r = await fetch(`${B}/api/ask?network=devnet`, { method: 'POST', headers: { 'x-sauti-key': KEY, origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Tuma USDT 5 kwa Amina' }) })
    assert.equal(r.status, 200)
    assert.equal((await r.json()).view.decision, 'confirm')
  } finally {
    br.kill(); eng.close(); rmSync(DATA, { recursive: true, force: true })
  }
})

test('bridge: a stalled upload is still cut off', async () => {
  const eng = await fakeEngine(0)
  const br = await startBridge()
  try {
    const t0 = Date.now()
    const outcome = await new Promise((resolve) => {
      const req = http.request(`${B}/api/ask?network=devnet`, { method: 'POST', headers: { 'x-sauti-key': KEY, origin: B, 'content-type': 'application/json', 'content-length': '100' } }, (res) => { res.resume(); resolve(`status ${res.statusCode}`) })
      req.on('error', (e) => resolve(`error ${e.code || e.message}`))
      req.write('{"text": "x') // 11 of 100 bytes, then nothing
      setTimeout(() => { req.destroy(); resolve('still open after 5 s') }, 5000)
    })
    assert.notEqual(outcome, 'still open after 5 s')
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms (${outcome})`)
  } finally {
    br.kill(); eng.close(); rmSync(DATA, { recursive: true, force: true })
  }
})

test('bridge: API calls need this launch\'s UI key; the page does not', async () => {
  const eng = await fakeEngine(0)
  const br = await startBridge()
  try {
    const post = (headers) => fetch(`${B}/api/ask?network=devnet`, { method: 'POST', headers: { origin: B, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text: 'Tuma USDT 5 kwa Amina' }) })
    assert.equal((await post({})).status, 401)
    assert.equal((await post({ 'x-sauti-key': randomBytes(32).toString('base64url') })).status, 401)
    assert.equal((await post({ 'x-sauti-key': KEY + 'x' })).status, 401)
    assert.equal((await post({ 'x-sauti': '1' })).status, 401, 'the old fixed header is not enough')
    assert.equal((await post({ 'x-sauti-key': KEY })).status, 200, 'control: the right key works')
    assert.equal((await fetch(`${B}/`)).status, 200, 'the page loads without the key')
  } finally {
    br.kill(); eng.close(); rmSync(DATA, { recursive: true, force: true })
  }
})

test('bridge: refuses to start without a UI key', async () => {
  const p = spawn(process.execPath, [join(ROOT, 'bin/bridge.mjs')], { env: { PATH: process.env.PATH, SAUTI_UI_PORT: String(PORT + 1) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  p.stderr.on('data', (d) => { err += d })
  const code = await new Promise((resolve) => p.on('exit', resolve))
  assert.equal(code, 2)
  assert.match(err, /no UI key/)
})
