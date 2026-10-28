// End-to-end test of the local app through the 127.0.0.1 bridge: real engine (offline sandbox, real QVAC
// models, real WDK signing), throwaway wallet under tmp/e2e-ui, local devnet for the network side.
// Run by test/e2e_ui.sh (which starts the engine + bridge). Host-side code, Node built-ins only.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const PORT = Number(process.env.SAUTI_UI_PORT || 8788)
const B = `http://127.0.0.1:${PORT}`
const ORIGIN = B
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KEY = process.env.SAUTI_UI_TOKEN || '' // this launch's UI key (test/e2e_ui.sh made it and gave it to the bridge)
if (!/^[A-Za-z0-9_-]{32,128}$/.test(KEY)) throw new Error('SAUTI_UI_TOKEN missing: run test/e2e_ui.sh')
let pass = 0
const fails = []
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fails.push(name); console.log(`  FAIL ${name} ${extra}`) } }

async function call (path, { method = 'GET', json, body, type, headers = {} } = {}) {
  const h = { 'x-sauti-key': KEY, ...(method !== 'GET' ? { origin: ORIGIN } : {}), ...headers }
  let payload
  if (json !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(json) } else if (body !== undefined) { h['content-type'] = type; payload = body }
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k]
  const r = await fetch(B + path, { method, headers: h, body: payload })
  let j = null
  try { j = await r.json() } catch {}
  return { status: r.status, j, headers: r.headers }
}

// raw request with an arbitrary Host header (fetch does not allow overriding Host)
function rawHost (host, path) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { host, 'x-sauti-key': KEY } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', () => resolve(0))
    req.end()
  })
}

const ask = (text, network = 'devnet') => call(`/api/ask?network=${network}`, { method: 'POST', json: { text, lang: 'sw' } })
const confirm = (sid, retype) => call('/api/confirm', { method: 'POST', json: { sid, ...(retype !== undefined ? { retype } : {}) } })
async function waitJob () {
  for (let i = 0; i < 240; i++) {
    const r = await call('/api/net/job')
    if (r.j?.job && !r.j.job.running) return r.j.job
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('net job did not finish')
}
async function waitReady () {
  for (let i = 0; i < 240; i++) {
    const r = await call('/api/status?network=devnet').catch(() => null)
    if (r?.j?.engine?.ready) return r.j
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('engine did not become ready')
}

console.log('status and offline proof')
const st = await waitReady()
ok(st.net.online === false, 'engine reports network OFF')
ok(JSON.stringify(st.net.interfaces) === '["lo"]', 'engine sees only the lo interface', JSON.stringify(st.net.interfaces))
ok(st.net.tcp_ipv4.ok === false && st.net.dns.ok === false, 'TCP and DNS fail inside the engine')
ok(st.chain.usdt === '1000', 'devnet balance 1000 after setup', st.chain.usdt)
ok(!JSON.stringify(st).match(/seed|mnemonic|privateKey/i), 'status carries no seed or key fields')

console.log('static files and route hygiene')
let r = await fetch(`${B}/`)
const csp = r.headers.get('content-security-policy') || ''
ok(r.status === 200 && csp.includes("default-src 'none'") && csp.includes("connect-src 'self'"), 'UI served with a strict CSP')
ok(r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff', 'frame + sniffing headers set')
r = await fetch(`${B}/app.js`)
ok(r.status === 200 && (r.headers.get('content-type') || '').startsWith('text/javascript'), 'app.js served as javascript')
for (const p of ['/../private/wallet.json', '/private/wallet.json', '/%2e%2e/private/wallet.json', '/config.json', '/ui/app.js', '/node_modules/ethers/package.json']) {
  r = await fetch(B + p)
  const text = await r.text()
  ok(r.status === 404 && !text.includes('seed'), `no file outside the allow-list: ${p}`, String(r.status))
}
ok((await call('/api/nope')).status === 404, 'unknown API route -> 404')

console.log('cross-site and rebinding defences')
ok(await rawHost('evil.example:8788', '/api/status') === 421, 'foreign Host header refused (DNS rebinding)')
ok(await rawHost(`127.0.0.1:${PORT}`, '/api/status') === 200, 'own Host header accepted (control)')
ok((await call('/api/status', { headers: { 'x-sauti-key': null } })).status === 401, 'API without the UI key refused')
ok((await call('/api/status', { headers: { 'x-sauti-key': randomBytes(32).toString('base64url') } })).status === 401, 'API with a wrong UI key refused')
ok((await call('/api/status', { headers: { 'x-sauti-key': KEY.slice(0, -1) } })).status === 401, 'API with a truncated UI key refused')
ok((await call(`/api/status?k=${KEY}`, { headers: { 'x-sauti-key': null } })).status === 401, 'UI key in the URL instead of the header refused')
ok((await call('/api/confirm', { method: 'POST', json: { sid: 'x' }, headers: { 'x-sauti-key': null } })).status === 401, 'confirm without the UI key refused')
ok((await call('/api/net/job', { headers: { 'x-sauti-key': null } })).status === 401, 'network job status without the UI key refused')
ok((await fetch(`${B}/`)).status === 200, 'the page itself loads without the key (control: only the API needs it)')
ok((await call('/api/ask?network=devnet', { method: 'POST', json: { text: 'Tuma USDT 1 kwa Amina' }, headers: { origin: 'https://evil.example' } })).status === 403, 'cross-origin POST refused')
ok((await call('/api/ask?network=devnet', { method: 'POST', json: { text: 'Tuma USDT 1 kwa Amina' }, headers: { origin: null } })).status === 403, 'POST without Origin refused')
ok((await call('/api/ask?network=devnet', { method: 'POST', body: '{"text":"x"}', type: 'text/plain' })).status === 415, 'text/plain body refused (no simple-request CSRF)')
ok((await call('/api/status?network=mainnet')).status === 400, 'unknown network parameter refused')
ok((await call('/api/voice?network=devnet&lang=xx', { method: 'POST', body: Buffer.from('RIFF0000WAVE'), type: 'audio/wav' })).status === 400, 'bad lang parameter refused')

console.log('size and type limits')
ok((await call('/api/ask?network=devnet', { method: 'POST', body: JSON.stringify({ text: 'a'.repeat(20000) }), type: 'application/json' })).status === 413, 'JSON over 16 KB -> 413')
ok((await call('/api/voice?network=devnet&lang=sw', { method: 'POST', body: Buffer.alloc(6 * 1024 * 1024), type: 'audio/wav' })).status === 413, 'audio over 5 MB -> 413')
ok((await call('/api/voice?network=devnet&lang=sw', { method: 'POST', body: Buffer.from('ID3 not a wav file at all, just bytes........'), type: 'audio/wav' })).status === 415, 'non-WAV bytes refused by content')
const fakeWav = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary'), Buffer.alloc(40)])
r = await call('/api/voice?network=devnet&lang=sw', { method: 'POST', body: fakeWav, type: 'audio/wav' })
ok(r.status === 400, 'RIFF header with a broken body refused by the engine (content check)', `${r.status} ${r.j?.error}`)
ok((await call('/api/voice?network=devnet&lang=sw', { method: 'POST', body: readFileSync(`${ROOT}test/audio/sw_juma_15.wav`), type: 'audio/ogg' })).status === 415, 'audio with a non-WAV content type refused')
ok((await call('/api/ask?network=devnet', { method: 'POST', json: { text: '   ' } })).status === 400, 'empty request refused')
ok((await call('/api/ask?network=devnet', { method: 'POST', body: '[1,2]', type: 'application/json' })).status === 400, 'non-object JSON refused')

console.log('one request at a time')
const [a1, a2] = await Promise.all([ask('Tuma USDT 2 kwa Amina'), ask('Tuma USDT 3 kwa Juma')])
ok([a1.status, a2.status].sort().join(',') === '200,429', 'second concurrent AI request gets 429', `${a1.status},${a2.status}`)

console.log('payments (text + voice) and the confirmation rules')
r = await ask('Tuma USDT ishirini kwa Amina kwa ajili ya kodi')
ok(r.status === 200 && r.j.view.decision === 'confirm' && r.j.view.amount === '20' && r.j.view.recipient.name === 'Amina', 'Swahili text request understood', JSON.stringify(r.j?.view?.amount))
ok(r.j.view.groups.length === 6 && r.j.view.groups.every((g) => g.status === 'ok'), 'six check groups, all passed')
ok(r.j.steps.find((s) => s.id === 'llm')?.cached_tokens > 300, 'LLM prompt prefix served from the KV cache', JSON.stringify(r.j.steps))
let c = await confirm(r.j.sid)
ok(c.status === 200 && c.j.queued.status === 'queued' && c.j.queued.nonce === 0, 'confirmed -> signed offline and queued (nonce 0)', JSON.stringify(c.j?.queued || c.j))
ok(!JSON.stringify(c.j).match(/"raw"|seed/i), 'confirm response has no raw tx or seed')
ok((await confirm(r.j.sid)).status === 410, 'the same confirmation cannot be used twice')
ok((await confirm('0'.repeat(32))).status === 410, 'unknown session id refused')

const v = await call('/api/voice?network=devnet&lang=sw', { method: 'POST', body: readFileSync(`${ROOT}test/audio/sw_juma_15.wav`), type: 'audio/wav' })
ok(v.status === 200 && /juma/i.test(v.j.transcript) && v.j.steps[0].id === 'asr', 'voice note transcribed on device', v.j?.transcript)
r = await ask(v.j.transcript)
ok(r.j?.view?.amount === '15' && r.j.view.recipient?.name === 'Juma', 'voice request -> 15 USDT to Juma', JSON.stringify(r.j?.view?.amount))
c = await confirm(r.j.sid)
ok(c.status === 200 && c.j.queued.nonce === 1, 'voice payment signed + queued (nonce 1)')
ok(/Swahili Whisper/.test(v.j.steps[0].asr_model || ''), 'Swahili voice note heard by the Swahili fine-tune of Whisper', v.j.steps[0].asr_model)
// English uses the multilingual Whisper: the engine swaps the speech model (still one in RAM), then back for Swahili
const ve = await call('/api/voice?network=devnet&lang=en', { method: 'POST', body: readFileSync(`${ROOT}test/audio/en_otieno_40.wav`), type: 'audio/wav' })
ok(ve.status === 200 && /otieno/i.test(ve.j.transcript) && /\b40\b/.test(ve.j.transcript) && ve.j.steps[0].asr_model === 'whisper small q8_0', 'English voice note heard by the multilingual Whisper (model swap)', `${ve.j?.transcript} | ${ve.j?.steps?.[0]?.asr_model}`)
const sm = await call('/api/status?network=devnet')
ok(/Swahili Whisper.*\(sw\).*whisper small q8_0 \(en\)/.test(sm.j.engine.models.asr), 'status names both speech models', sm.j.engine.models.asr)

r = await ask('send 60 USDT to Otieno for rent')
ok(r.j?.view?.needsRetype === true && r.j.view.decision !== 'blocked', 'large amount needs the re-type step')
ok((await confirm(r.j.sid)).status === 400, 'large amount without re-typing refused')
ok((await confirm(r.j.sid, '600')).status === 400, 'wrong re-typed amount refused')
c = await confirm(r.j.sid, '60')
ok(c.status === 200 && c.j.queued.amount === '60', 'correct re-typed amount signs')

r = await ask('tuma kwa Otieno')
ok(r.j?.view?.amountQuestion?.kind === 'ask' && r.j.view.decision === 'blocked' && !r.j.view.hardBlock, 'no amount said -> the app asks how much (not blocked for good)', JSON.stringify(r.j?.view?.amountQuestion))
ok((await confirm(r.j.sid)).status === 409, 'cannot confirm before answering')
let m = await call('/api/amend', { method: 'POST', json: { sid: r.j.sid, amount: '0' } })
ok(m.status === 400, 'zero amount refused')
m = await call('/api/amend', { method: 'POST', json: { sid: r.j.sid, amount: '5' } })
ok(m.status === 200 && m.j.view.decision !== 'blocked' && m.j.view.amount === '5', 'typed amount accepted, checks re-run without the model', JSON.stringify(m.j?.view?.decision))
c = await confirm(r.j.sid)
ok(c.status === 200 && c.j.queued.amount === '5', 'answered request signs')

r = await ask('Tuma USDT 10 kwa Amiina')
if (r.j?.view?.contactQuestion) {
  ok(r.j.view.contactQuestion.candidates.some((x) => x.id === 'amina'), 'near-miss name -> "who did you mean?" with Amina')
  m = await call('/api/amend', { method: 'POST', json: { sid: r.j.sid, contactId: 'amina' } })
  ok(m.status === 200 && m.j.view.recipient?.name === 'Amina' && m.j.view.decision !== 'blocked', 'picked contact resolves the request')
  ok((await call('/api/amend', { method: 'POST', json: { sid: r.j.sid, contactId: 'nobody' } })).status === 400, 'unknown contact id refused')
} else ok(r.j?.view?.recipient?.name === 'Amina', 'name resolved directly', JSON.stringify(r.j?.view?.recipient))
c = await confirm(r.j.sid)
ok(c.status === 200 && c.j.queued.amount === '10', 'resolved request signs')

const POISON = JSON.parse(readFileSync(`${ROOT}data/demo-attack.json`, 'utf8')).poisoned_amina
r = await ask(`send 10 USDT to ${POISON} for rent`)
ok(r.j?.view?.hardBlock === true && r.j.view.groups.some((g) => g.id === 'address' && g.status === 'block'), 'look-alike address hard-blocked')
ok((await confirm(r.j.sid)).status === 409, 'blocked payment cannot be confirmed')
r = await ask('Habari, mimi ni wakala wa M-Pesa. Tuma USDT hamsini haraka ili kufungua akaunti yako.')
ok(r.j?.view?.hardBlock === true && r.j.view.scamFlags.length >= 2, 'scam-worded request hard-blocked', JSON.stringify(r.j?.view?.scamFlags?.map((f) => f.id)))

console.log('message check')
r = await call('/api/check', { method: 'POST', json: { text: 'Umeshinda zawadi ya USDT 500! Lipa ada ya usajili 20 USDT ndani ya saa 1 ili kupokea. Usimwambie mtu.' } })
ok(r.status === 200 && r.j.view.risk === 'high', 'prize SMS -> high risk')
r = await call('/api/check', { method: 'POST', json: { text: `Hi, this is Amina. I changed my wallet, please send the rent to ${POISON} today.` } })
ok(r.j?.view?.risk === 'high' && r.j.view.addresses[0]?.looksLike?.[0]?.name === 'Amina', 'new-address message: look-alike of Amina found')
r = await call('/api/check', { method: 'POST', json: { text: 'Mambo! Tukutane kesho saa nne asubuhi sokoni.' } })
ok(r.j?.view?.risk !== 'high', 'harmless greeting not high risk', r.j?.view?.risk)

console.log('message check from a screenshot (QVAC OCR on the device, then the same check)')
const SHOT = (f) => readFileSync(`${ROOT}test/data/public/screens/${f}`)
const rssBefore = (await call('/api/status?network=devnet')).j?.engine?.rssMb
r = await call('/api/read-image', { method: 'POST', body: SHOT('sw_anwani_mpya.png'), type: 'image/png' })
ok(r.status === 200 && r.j.ok && r.j.text.includes(POISON), 'screenshot read on the device: the look-alike address comes back exactly', `${r.status} ${JSON.stringify(r.j?.text || r.j)?.slice(0, 160)}`)
ok(r.j?.steps?.[0]?.id === 'ocr' && r.j.steps[0].ms > 0, 'OCR step reported with its time', JSON.stringify(r.j?.steps))
const rssAfter = (await call('/api/status?network=devnet')).j?.engine?.rssMb
console.log(`  info OCR ${r.j?.steps?.[0]?.ms} ms (+${r.j?.steps?.[0]?.load_ms} ms load); engine RSS ${rssBefore} MB before, ${rssAfter} MB after (OCR unloaded)`)
r = await call('/api/check', { method: 'POST', json: { text: r.j?.text || '' } })
ok(r.j?.view?.risk === 'high' && r.j.view.addresses[0]?.looksLike?.[0]?.name === 'Amina', 'screenshot text -> same check -> high risk, look-alike of Amina', r.j?.view?.risk)
r = await call('/api/read-image', { method: 'POST', body: SHOT('sw_kawaida.png'), type: 'image/png' })
const genuine = await call('/api/check', { method: 'POST', json: { text: r.j?.text || '' } })
ok(r.status === 200 && ['none', 'low'].includes(genuine.j?.view?.risk), 'genuine screenshot not rated medium or high', `${r.status} ${genuine.j?.view?.risk}`)
ok((await call('/api/read-image', { method: 'POST', body: readFileSync(`${ROOT}test/audio/sw_juma_15.wav`), type: 'image/png' })).status === 415, 'WAV bytes sent as image/png refused by content')
ok((await call('/api/read-image', { method: 'POST', body: SHOT('sw_kawaida.png'), type: 'text/plain' })).status === 415, 'screenshot with a non-image content type refused')
ok((await call('/api/read-image', { method: 'POST', body: Buffer.alloc(5 * 1024 * 1024), type: 'image/png' })).status === 413, 'image over 4 MB -> 413')
const bomb = Buffer.from(SHOT('sw_kawaida.png')); bomb.writeUInt32BE(50000, 16); bomb.writeUInt32BE(50000, 20)
r = await call('/api/read-image', { method: 'POST', body: bomb, type: 'image/png' })
ok(r.status === 400 && /too big/.test(r.j?.error || ''), 'PNG announcing 50000x50000 px refused before decoding', `${r.status} ${r.j?.error}`)
// the engine frees the speech model while it reads a screenshot: the next voice note must load it again and work
const v2 = await call('/api/voice?network=devnet&lang=sw', { method: 'POST', body: readFileSync(`${ROOT}test/audio/sw_juma_15.wav`), type: 'audio/wav' })
ok(v2.status === 200 && /juma/i.test(v2.j.transcript) && /Swahili Whisper/.test(v2.j.steps[0].asr_model || ''), 'voice works again after a screenshot (Swahili speech model reloaded)', `${v2.status} ${v2.j?.transcript} ${v2.j?.steps?.[0]?.ms} ms`)

console.log('outbox -> broadcast on the local devnet (separate keyless process)')
let ob = await call('/api/outbox?network=devnet')
ok(ob.j.entries.filter((e) => e.status === 'queued').length === 5, '5 payments queued', String(ob.j.entries.length))
ok(ob.j.entries.every((e) => !('raw' in e)), 'outbox view has no raw transactions')
r = await call('/api/net/broadcast', { method: 'POST', json: { network: 'mainnet' } })
ok(r.status === 400, 'broadcast to an unknown network refused')
r = await call('/api/net/broadcast', { method: 'POST', json: { network: 'devnet' } })
ok(r.status === 202, 'broadcast job started')
ok((await ask('Tuma USDT 2 kwa Amina')).status === 429, 'AI requests wait while the broadcaster runs')
let job = await waitJob()
ok(job.code === 0, 'broadcaster exited 0', job.lines.slice(-3).join(' | '))
ob = await call('/api/outbox?network=devnet')
ok(ob.j.entries.filter((e) => e.status === 'confirmed').length === 5, 'all 5 confirmed on the devnet')
const s2 = await call('/api/status?network=devnet')
ok(s2.j.chain.usdt === '890', 'balance 1000 - 110 = 890', s2.j.chain.usdt)

console.log('stale nonce -> needs_resign -> re-sign offline -> confirmed')
r = await ask('Tuma USDT 3 kwa Juma')
c = await confirm(r.j.sid)
ok(c.status === 200 && c.j.queued.nonce === 5, 'payment queued with nonce 5')
execFileSync(`${ROOT}ops/devnet.sh`, ['devnet-bump-nonce'], { env: { PATH: '/usr/bin:/bin', SAUTI_DATA: process.env.SAUTI_DATA, HOME: `${ROOT}home` }, stdio: 'pipe' })
r = await call('/api/net/broadcast', { method: 'POST', json: { network: 'devnet' } })
job = await waitJob()
ob = await call('/api/outbox?network=devnet')
const stale = ob.j.entries.find((e) => e.id === c.j.queued.id)
ok(stale?.status === 'needs_resign', 'nonce taken elsewhere -> needs_resign (after checking this tx was not mined)', `${stale?.status} ${job.lines.slice(-2).join(' | ')}`)
ok((await call('/api/resign', { method: 'POST', json: { id: stale.id, network: 'devnet' } })).status === 400, 're-sign without the person confirming refused')
r = await call('/api/resign', { method: 'POST', json: { id: stale.id, network: 'devnet', confirm: true } })
ok(r.status === 200 && r.j.entry.status === 'queued' && r.j.entry.nonce === 6 && r.j.entry.resigned === 1, 're-signed offline with nonce 6', JSON.stringify(r.j?.entry || r.j))
ok((await call('/api/resign', { method: 'POST', json: { id: stale.id, network: 'devnet', confirm: true } })).status === 400, 'a queued entry cannot be re-signed again')
await call('/api/net/broadcast', { method: 'POST', json: { network: 'devnet' } })
job = await waitJob()
ob = await call('/api/outbox?network=devnet')
ok(ob.j.entries.find((e) => e.id === stale.id)?.status === 'confirmed', 're-signed payment confirmed')
const s3 = await call('/api/status?network=devnet')
ok(s3.j.chain.usdt === '887', 'balance 887: the re-signed payment was paid once', s3.j.chain.usdt)

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log('FAILED:', fails.join('; ')); process.exit(1) }
console.log('E2E UI PASS')
