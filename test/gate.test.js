// The run gate (src/gate.js) for both modes: the bubblewrap sandbox ("offline") and the portable launcher
// ("portable", a laptop without bubblewrap with the network switched off). Scripted probes, both directions:
// an all-unreachable probe passes; any reachable leg (IPv4, IPv6, DNS), a probe error or a malformed answer refuses;
// no mode or any other mode refuses without even probing. Plus the pieces portable mode needs on other systems
// (engine socket / Windows pipe, setup hints, memory report) and real launcher runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkGate, requireGate, reachable, RUN_MODES, PORTABLE_HINT } from '../src/gate.js'
import { networkProof } from '../src/offline.js'
import { engineSocket, PIPE_RE } from '../src/sockpath.js'
import { modelKeyFor, fetchCommand, missingModelMessage } from '../src/setup_hint.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// a failed leg carries the code the bubblewrap sandbox gives (TCP: no route; DNS: no server reachable)
const leg = (ok, extra = {}, error = 'ENETUNREACH') => ({ ok, ...(ok ? {} : { error }), ...extra })
const proof = ({ ip4 = false, ip6 = false, dns = false, dns2 = false } = {}) => ({
  online: ip4 || ip6 || dns || dns2,
  sandbox: 'x',
  interfaces: ['lo'],
  tcp_ipv4: leg(ip4, { target: '1.1.1.1:443' }),
  tcp_ipv6: leg(ip6, { target: '[2606:4700:4700::1111]:443' }),
  dns: { target: 'huggingface.co', ...leg(dns, {}, 'EAI_AGAIN') },
  dns2: { target: 'example.com', ...leg(dns2, {}, 'EAI_AGAIN') },
  at: new Date().toISOString()
})
const probeOf = (p) => { const f = async () => { f.calls++; return p }; f.calls = 0; return f }

test('gate: offline probe -> allowed, in both modes', async () => {
  for (const mode of ['offline', 'portable']) {
    const probe = probeOf(proof())
    const g = await checkGate({ env: { SAUTI_SANDBOX: mode }, probe })
    assert.equal(g.ok, true, mode)
    assert.equal(g.mode, mode)
    assert.equal(probe.calls, 1)
  }
  assert.deepEqual(RUN_MODES, ['offline', 'portable'])
})

test('gate: any reachable leg (IPv4, IPv6, DNS) -> refused, portable message says to switch the network off', async () => {
  for (const legs of [{ ip4: true }, { ip6: true }, { dns: true }, { dns2: true }, { ip4: true, dns: true }, { ip4: true, ip6: true, dns: true, dns2: true }]) {
    const g = await checkGate({ env: { SAUTI_SANDBOX: 'portable' }, probe: probeOf(proof(legs)) })
    assert.equal(g.ok, false, JSON.stringify(legs))
    assert.equal(g.code, 'online')
    assert.match(g.message, /^refusing to start: the internet is reachable from this computer \(/)
    assert.ok(g.message.endsWith(PORTABLE_HINT), g.message)
    assert.equal(PORTABLE_HINT, 'Turn Wi-Fi/Ethernet off, then run again.')
    if (legs.ip4) assert.match(g.message, /tcp 1\.1\.1\.1:443 connected/)
    if (legs.ip6) assert.match(g.message, /tcp IPv6 connected/)
    if (legs.dns) assert.match(g.message, /dns huggingface\.co resolved/)
    if (legs.dns2) assert.match(g.message, /dns example\.com resolved/)
  }
  // the sandboxed mode keeps its own wording (test/e2e_ui.sh greps "internet is reachable")
  const g = await checkGate({ env: { SAUTI_SANDBOX: 'offline' }, probe: probeOf(proof({ dns: true })) })
  assert.equal(g.ok, false)
  assert.match(g.message, /^refusing to start: the internet is reachable from this process/)
})

test('gate: no mode, or any other mode -> refused as before, without probing', async () => {
  for (const v of [undefined, '', 'none', 'online', 'devnet', 'setup', 'host', 'Portable', 'portable ', ' offline', 'offline,portable', 'true', '1']) {
    const probe = probeOf(proof())
    const env = v === undefined ? {} : { SAUTI_SANDBOX: v }
    const g = await checkGate({ env, probe, launcher: 'node bin/serve.mjs' })
    assert.equal(g.ok, false, String(v))
    assert.equal(g.code, 'no_sandbox')
    assert.equal(probe.calls, 0, 'no probe without a valid mode')
    assert.match(g.message, /^refusing to start: run it inside the offline sandbox \(ops\/sandbox\.sh offline node bin\/serve\.mjs\)/)
    assert.match(g.message, /npm run portable -- <command>/)
  }
})

test('gate: fails closed on a probe error or a malformed / contradictory answer', async () => {
  const cases = [
    async () => { throw new Error('boom') },
    async () => null,
    async () => ({}),
    async () => 'offline',
    async () => ({ online: true }), // online, no reason given
    async () => ({ ...proof(), online: undefined }), // never said "offline"
    async () => ({ ...proof(), online: false, tcp_ipv4: { ok: true, target: '1.1.1.1:443' } }), // says offline, but a leg got through
    async () => ({ ...proof(), online: false, dns: { ok: true, target: 'huggingface.co' } })
  ]
  for (const [i, probe] of cases.entries()) {
    const g = await checkGate({ env: { SAUTI_SANDBOX: 'portable' }, probe })
    assert.equal(g.ok, false, `case ${i}`)
    assert.equal(g.code, 'online', `case ${i}`)
  }
  assert.deepEqual(reachable(proof()), [])
  assert.deepEqual(reachable(null), ['probe gave no answer'])
})

test('gate: before a signature the refusal says so; requireGate throws it and passes the gate result through', async () => {
  const g = await checkGate({ env: { SAUTI_SANDBOX: 'portable' }, probe: probeOf(proof({ ip4: true })), action: 'sign' })
  assert.match(g.message, /^refusing to sign: the internet is reachable/)
  await assert.rejects(requireGate({ env: { SAUTI_SANDBOX: 'portable' }, probe: probeOf(proof({ dns: true })), action: 'sign' }),
    (e) => /^refusing to sign: .*Turn Wi-Fi\/Ethernet off, then run again\.$/.test(e.message) && e.gate.code === 'online')
  await assert.rejects(requireGate({ env: {}, probe: probeOf(proof()), action: 'sign' }), (e) => /^refusing to sign: run it inside the offline sandbox/.test(e.message))
  const ok = await requireGate({ env: { SAUTI_SANDBOX: 'offline' }, probe: probeOf(proof()), action: 'sign' })
  assert.equal(ok.ok, true)
  const run = await checkGate({ env: { SAUTI_SANDBOX: 'portable' }, probe: probeOf(proof({ ip6: true })), action: 'run' })
  assert.match(run.message, /^refusing to run this request: /)
})

test('gate: the default probe is the live one from src/offline.js (same legs the UI shows)', async () => {
  const p = await networkProof()
  const g = await checkGate({ env: { SAUTI_SANDBOX: 'portable' } })
  assert.equal(g.ok, p.online === false && reachable(p).length === 0)
})

test('launchers: before the gate they load Node built-ins and our own gate files only (no third-party code)', () => {
  const allowed = new Set(['bin/sauti.mjs', 'bin/serve.mjs', 'bin/portable.mjs', 'bin/bridge.mjs', 'src/gate.js', 'src/offline.js', 'src/sockpath.js', 'src/setup_hint.js', 'src/launch_env.js'])
  const seen = new Set()
  const walk = (rel) => {
    if (seen.has(rel)) return
    seen.add(rel)
    assert.ok(allowed.has(rel), `${rel} is loaded before the gate`)
    const src = readFileSync(join(ROOT, rel), 'utf8')
    for (const m of src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = m[1]
      if (spec.startsWith('node:')) continue
      assert.ok(spec.startsWith('.'), `${rel} imports a package (${spec}) at top level`)
      walk(relative(ROOT, join(ROOT, rel, '..', spec)).split('\\').join('/'))
    }
  }
  for (const f of ['bin/sauti.mjs', 'bin/serve.mjs', 'bin/portable.mjs', 'bin/bridge.mjs']) walk(f)
  // and the CLI / engine are only reached through a dynamic import after the gate
  for (const f of ['bin/sauti.mjs', 'bin/serve.mjs']) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(src.indexOf('checkGate(') < src.indexOf('await import('), f)
  }
})

test('engine socket: Unix socket path as before; Windows only via the launcher\'s random pipe; long paths refused', () => {
  const root = '/home/x/sauti-pesa/'
  assert.deepEqual(engineSocket({ root, data: root, env: {}, platform: 'linux' }), { path: '/home/x/sauti-pesa/tmp/run/engine.sock', pipe: false })
  assert.deepEqual(engineSocket({ root, data: '/home/x/sauti-pesa/tmp/e2e-ui', env: {}, platform: 'darwin' }), { path: '/home/x/sauti-pesa/tmp/e2e-ui/run/engine.sock', pipe: false })
  const good = '\\\\.\\pipe\\sauti-pesa-0123456789abcdef0123456789abcdef'
  assert.deepEqual(engineSocket({ root, data: root, env: { SAUTI_ENGINE_PIPE: good }, platform: 'win32' }), { path: good, pipe: true })
  for (const bad of [undefined, '', '\\\\.\\pipe\\other', '\\\\.\\pipe\\sauti-pesa-0123', `${good}x`, `\\\\?\\pipe\\sauti-pesa-${'a'.repeat(32)}`, `\\\\.\\pipe\\sauti-pesa-${'A'.repeat(32)}`, `C:\\tmp\\engine.sock`, `${good}\\..\\x`]) {
    assert.throws(() => engineSocket({ root, data: root, env: bad === undefined ? {} : { SAUTI_ENGINE_PIPE: bad }, platform: 'win32' }), /npm run portable -- ui/, String(bad))
    assert.equal(PIPE_RE.test(String(bad)), false)
  }
  const deep = `/Users/judge/${'d'.repeat(70)}/sauti-pesa/`
  assert.throws(() => engineSocket({ root: deep, data: deep, env: {}, platform: 'darwin' }), /too long for a local socket/)
  const p104 = '/' + 'a'.repeat(103 - '/tmp/run/engine.sock'.length - 1) + '/'
  assert.equal(Buffer.byteLength(engineSocket({ root: p104, data: p104, env: {}, platform: 'darwin' }).path), 103)
})

test('setup hints: a missing model names the exact download command for the mode', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  assert.equal(modelKeyFor(ROOT, cfg.models.llm), 'QWEN3_1_7B_INST_Q4')
  assert.equal(modelKeyFor(ROOT, cfg.models.asr), 'WHISPER_SMALL_Q8_0')
  assert.equal(modelKeyFor(ROOT, cfg.models.asr_sw), 'WHISPER_SMALL_SW_Q8_0')
  assert.equal(modelKeyFor(ROOT, cfg.models.vad), 'VAD_SILERO_5_1_2')
  assert.equal(modelKeyFor(ROOT, 'models/nope.bin'), null)
  assert.equal(fetchCommand(['A', 'B'], { SAUTI_SANDBOX: 'portable' }), 'npm run fetch-models -- A B')
  assert.equal(fetchCommand(['A'], { SAUTI_SANDBOX: 'offline' }), 'scripts/fetch_models.sh A')
  assert.equal(missingModelMessage(ROOT, cfg.models.llm, { SAUTI_SANDBOX: 'portable' }),
    'model missing: models/Qwen3-1.7B-Q4_0.gguf (download it once, with the internet on: npm run fetch-models -- QWEN3_1_7B_INST_Q4)')
})

test('memory report outside the sandbox: only this process tree, never other programs', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { currentRssMb, peakRssMb } from './src/procmem.js'; console.log(JSON.stringify({ pid: process.pid, cur: currentRssMb(), peak: peakRssMb() }))"],
  { cwd: ROOT, env: { ...process.env, SAUTI_SANDBOX: 'portable' }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const o = JSON.parse(r.stdout)
  for (const k of [...Object.keys(o.cur), ...Object.keys(o.peak)]) assert.equal(Number(k.split(':').pop()), o.pid, k)
  assert.ok(Object.keys(o.cur).length >= 1 && Object.keys(o.peak).length >= 1)
})

test('launcher, real run: portable mode refuses while online and starts while offline (whichever this machine is)', async () => {
  const p = await networkProof()
  const data = mkdtempSync(join(ROOT, 'tmp', 'gate-test-'))
  try {
    const env = { ...process.env, SAUTI_DATA: relative(ROOT, data) }
    delete env.SAUTI_SANDBOX
    const r = spawnSync(process.execPath, ['bin/portable.mjs', 'queue'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 })
    if (p.online || reachable(p).length) {
      assert.equal(r.status, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /refusing to start: the internet is reachable from this computer .*Turn Wi-Fi\/Ethernet off, then run again\./)
    } else {
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /network: OFF \(verified: no route, no DNS\) \| sandbox: portable/)
    }
    // without the launcher and without a mode: refused as before, whatever the network
    const h = spawnSync(process.execPath, ['bin/sauti.mjs', 'queue'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 })
    assert.equal(h.status, 2)
    assert.match(h.stderr, /^refusing to start: run it inside the offline sandbox/)
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})
