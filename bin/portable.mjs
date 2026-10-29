#!/usr/bin/env node
// Portable launcher: run Sauti Pesa on a laptop WITHOUT bubblewrap (macOS, Windows, or Linux without bwrap), with the
// network switched off by the person. Node built-ins only; works the same from any shell:
//   npm run portable -- probe                  is the network really off? (prints the live probe)
//   npm run portable -- demo                   the whole offline flow in ~1 min, throwaway wallet (tmp/portable-demo)
//   npm run portable -- ui                     the app: engine + 127.0.0.1 bridge, prints the link to open
//   npm run portable -- <CLI command> ...      wallet init | contacts demo | ask "..." | say file.wav | check "..." | queue
//                                              | cancel <id> | resign <id>   (see src/cli.mjs)
// (ops/portable.sh <command> does the same from a POSIX shell.)
//
// What portable mode is, and is not:
// - It sets SAUTI_SANDBOX=portable for the CLI / engine / bridge it starts. They run the SAME live probe as the
//   sandboxed path (src/offline.js: TCP to 1.1.1.1:443 and to its IPv6 twin, DNS for huggingface.co and example.com)
//   at startup, again before every signature, and (the engine) before every AI request, and refuse while any of them
//   gets through or fails in a way that does not mean "no network".
// - The children get a SHORT, rebuilt environment (an allowlist, below), HOME/USERPROFILE = the project's home/, and on
//   Linux/macOS a private 0700 temp folder in the project (tmp/pt) for QVAC's worker socket. The launcher refuses to
//   start when NODE_OPTIONS is set or node was started with extra flags (both would run code before our checks).
// - It is NOT a sandbox: no namespace, no read-only project, no masked directories. The guarantee is "the network
//   is off, proven by a probe", not "this process cannot reach a network". On Linux the bubblewrap path
//   (ops/sandbox.sh offline, ops/ui.sh) stays the default and the stronger one.
// - It never broadcasts and never downloads: models must already be on disk (npm run fetch-models, online, once);
//   signed payments stay in the outbox. Test networks and a TEST wallet only, as everywhere in this project.
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, rmSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { checkGate } from '../src/gate.js'
import { networkProof } from '../src/offline.js'
import { uiPort } from '../src/sockpath.js'
import { childEnvFrom, startProblem, dataFromEnv, privateTmp } from '../src/launch_env.js'
import { modelKeyFor, fetchCommand } from '../src/setup_hint.js'
import { loadConfig } from '../src/profile.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// `--lite` before the command (or SAUTI_PROFILE=lite): the phone-class model profile, Qwen3-0.6B for intent (src/profile.js)
const ARGV = process.argv.slice(2)
const LITE = ARGV[0] === '--lite'
if (LITE) ARGV.shift()
const CFG = configOrExit()
const CLI_COMMANDS = ['wallet', 'contacts', 'ask', 'say', 'check', 'queue', 'cancel', 'resign']
const DEMO_DATA = 'tmp/portable-demo'

const USAGE = `Sauti Pesa, portable mode (no bubblewrap; switch the network OFF first)
  npm run portable -- probe            show the live network check (must say OFF)
  npm run portable -- demo             the whole offline flow, ~1 min, throwaway test wallet (tmp/portable-demo)
  npm run portable -- ui               start the app, then open the printed http://127.0.0.1:8787/#k=... link
  npm run portable -- --lite ui        the same with the phone-class profile (Qwen3-0.6B for intent; npm run fetch-models -- --lite)
  npm run portable -- wallet init      then: contacts demo | ask "Tuma USDT ishirini kwa Amina" | say <file.wav>
                                       | check "<message>" | queue | cancel <id> | resign <id>
One-time setup, with the internet ON:  npm ci   and   npm run fetch-models
Portable mode never broadcasts; on Linux the bubblewrap sandbox (ops/sandbox.sh offline ...) is the default.`

function configOrExit () {
  try { return loadConfig(ROOT, { SAUTI_PROFILE: LITE ? 'lite' : (process.env.SAUTI_PROFILE || '') }) } catch (e) { console.error(`refusing to start: ${e.message}`); process.exit(2) }
}

let tmpCache = null
function childEnv (extra = {}) {
  const home = join(ROOT, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const tmp = process.platform === 'win32' ? null : (tmpCache || (tmpCache = privateTmp()))
  return childEnvFrom(process.env, { home, tmp, data: dataFromEnv(), extra: CFG.profile === 'default' ? extra : { ...extra, SAUTI_PROFILE: CFG.profile } })
}

function run (script, args, env, { capture = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true })
    let out = ''
    if (capture) {
      const on = (d) => { const s = d.toString('utf8'); out += s; process.stdout.write(s) }
      p.stdout.on('data', on)
      p.stderr.on('data', on)
    }
    p.on('error', (e) => resolve({ code: 1, out: out + String(e.message) }))
    p.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

// Model files the command will load (config.json), as models.json keys; optional ones only warn.
function neededModels (cmd, args) {
  const llm = [CFG.models.llm]
  const speech = [CFG.models.asr, CFG.models.vad]
  const need = { ui: [...llm, ...speech], demo: [...llm, ...speech], ask: llm, say: [...llm, ...speech], check: args.includes('--no-ai') ? [] : llm }[cmd] || []
  if (cmd === 'check' && args.includes('--image')) need.push(CFG.models.ocr, CFG.models.ocr_detector)
  return need.filter(Boolean)
}

function sizeOk (rel) {
  const key = modelKeyFor(ROOT, rel)
  const want = key ? JSON.parse(readFileSync(join(ROOT, 'models.json'), 'utf8'))[key].bytes : null
  try { const st = statSync(join(ROOT, rel)); return st.isFile() && (!want || st.size === want) } catch { return false }
}

function preflight (cmd, args) {
  const deps = ['@qvac/sdk', '@tetherto/wdk', '@tetherto/wdk-wallet-evm', 'ethers'].filter((d) => !existsSync(join(ROOT, 'node_modules', d, 'package.json')))
  if (deps.length) return `missing packages (${deps.join(', ')}): run once, with the internet ON: npm ci`
  const missing = neededModels(cmd, args).filter((rel) => !sizeOk(rel))
  if (missing.length) {
    const keys = missing.map((rel) => modelKeyFor(ROOT, rel) || rel)
    if (keys.some((k) => k === 'OCR_LATIN' || k === 'OCR_CRAFT')) {
      return 'the screenshot check needs OCR_LATIN + OCR_CRAFT, which QVAC publishes only in its own peer-to-peer registry; ' +
        'our fenced downloader for them is Linux-only (scripts/fetch_models.sh OCR_LATIN OCR_CRAFT). Typed and pasted messages are checked without them.'
    }
    return `model file missing or incomplete: ${missing.join(', ')}. Download once, with the internet ON, then switch it off again: ${fetchCommand(keys, { SAUTI_SANDBOX: 'portable' })}`
  }
  if (['ui', 'demo', 'say'].includes(cmd) && CFG.models.asr_sw && !sizeOk(CFG.models.asr_sw)) {
    console.log(`(optional: the Swahili speech model is missing, so Swahili voice notes use the multilingual Whisper; get it with ${fetchCommand(['WHISPER_SMALL_SW_Q8_0'], { SAUTI_SANDBOX: 'portable' })})`)
  }
  return null
}

async function gateOrExit () {
  const g = await checkGate({ env: { SAUTI_SANDBOX: 'portable' }, launcher: 'node bin/sauti.mjs ...' })
  if (!g.ok) { console.error(g.message); process.exit(2) }
  console.log(`[portable mode | network: OFF (verified: ${proofLine(g.proof)}) | no bubblewrap: keep the network off while it runs]`)
}

const proofLine = (p) => `tcp 1.1.1.1:443 ${p.tcp_ipv4?.error || 'failed'}, IPv6 ${p.tcp_ipv6?.error || 'failed'}, dns ${p.dns?.error || 'failed'} / ${p.dns2?.error || 'failed'}`

async function cmdProbe () {
  const p = await networkProof()
  const g = await checkGate({ env: { SAUTI_SANDBOX: 'portable' }, probe: async () => p })
  console.log(JSON.stringify({ ...p, sandbox: 'portable' }))
  if (g.ok) console.log(`network: OFF (verified: ${proofLine(p)}). Portable mode can run.`)
  else console.log(`network: ON. ${g.message.replace(/^refusing to start: /, '')}`)
  process.exit(g.ok ? 0 : 3)
}

async function cmdUi () {
  const given = process.env.SAUTI_UI_TOKEN || ''
  if (given && !/^[A-Za-z0-9_-]{32,128}$/.test(given)) { console.error('SAUTI_UI_TOKEN must be 32-128 URL-safe characters'); process.exit(2) }
  let port
  try { port = uiPort(process.env) } catch (e) { console.error(e.message); process.exit(2) }
  const token = given || randomBytes(32).toString('base64url')
  const pipe = process.platform === 'win32' ? { SAUTI_ENGINE_PIPE: `\\\\.\\pipe\\sauti-pesa-${randomBytes(16).toString('hex')}` } : {}
  const kids = []
  let stopping = false
  const stop = (code) => {
    if (stopping) return
    stopping = true
    for (const k of kids) { try { k.kill('SIGTERM') } catch {} }
    setTimeout(() => process.exit(code), 1500).unref()
  }
  const start = (script, env, stdout = 'inherit') => {
    const p = spawn(process.execPath, [join(ROOT, script)], { cwd: ROOT, env, stdio: ['inherit', stdout, 'inherit'], windowsHide: true })
    p.on('exit', (code) => stop(code ?? 1))
    kids.push(p)
    return p
  }
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))
  start('bin/serve.mjs', childEnv(pipe)) // the engine never gets the UI key
  const bridge = start('bin/bridge.mjs', childEnv({ ...pipe, SAUTI_UI_TOKEN: token, SAUTI_UI_PORT: String(port) }), 'pipe')
  // the link (with the key) is printed only once the bridge says it is listening on 127.0.0.1:<port>
  const ready = new RegExp(`Sauti Pesa UI: http://127\\.0\\.0\\.1:${port}(\\s|$)`, 'm')
  let seen = ''
  let shown = false
  const late = setTimeout(() => { if (!shown && !stopping) console.error(`the UI bridge has not started listening on 127.0.0.1:${port} after 60 s`) }, 60000)
  late.unref()
  bridge.stdout.on('data', (d) => {
    process.stdout.write(d)
    if (shown) return
    seen = (seen + d.toString('utf8')).slice(-4096)
    if (!ready.test(seen)) return
    shown = true
    clearTimeout(late)
    if (given) console.log(`UI: http://127.0.0.1:${port}/ (key from SAUTI_UI_TOKEN)`)
    else console.log(`Open this link (it holds this session's key; it changes at every start): http://127.0.0.1:${port}/#k=${token}`)
    console.log('Portable mode: payments are signed and kept in the outbox on this device; "Go online and send" is not available here.')
  })
}

// The offline flow end to end, as test/e2e_offline.sh does it in the sandbox (minus the devnet broadcast): throwaway
// test wallet, demo contacts, a Swahili text payment and an English voice note signed offline, a look-alike address
// blocked, a payment without an amount refused, a Swahili scam SMS rated high risk; then the two signatures are
// checked from the outbox alone (scripts/verify_outbox.mjs).
async function cmdDemo () {
  const data = join(ROOT, DEMO_DATA)
  if (existsSync(data)) {
    // only ever delete our own throwaway folder: a plain directory at exactly this path, not reached through a link
    const plain = !lstatSync(data).isSymbolicLink() && lstatSync(data).isDirectory() && realpathSync(data) === join(realpathSync(ROOT), DEMO_DATA)
    if (!plain) { console.error(`${DEMO_DATA} is not a plain directory inside this project; refusing to delete it`); process.exit(2) }
    rmSync(data, { recursive: true, force: true })
  }
  mkdirSync(data, { recursive: true })
  const env = childEnv({ SAUTI_DATA: DEMO_DATA })
  const poison = JSON.parse(readFileSync(join(ROOT, 'data/demo-attack.json'), 'utf8')).poisoned_amina
  const steps = [
    { title: 'test wallet (new seed, stays in tmp/portable-demo/private/)', args: ['wallet', 'init'], expect: [/test wallet created/] },
    { title: '5 demo contacts', args: ['contacts', 'demo'], expect: [/demo contacts installed/] },
    { title: 'Swahili text payment: checks -> signed offline', args: ['ask', 'Tuma USDT ishirini kwa Amina kwa ajili ya kodi', '--yes'], expect: [/network: OFF/, /Imesainiwa kwenye kifaa/] },
    { title: 'English voice note: speech to text -> checks -> signed offline', args: ['say', 'test/audio/en_brother_15.wav', '--lang', 'en', '--yes'], expect: [/Signed on this device \(offline\) and queued/] },
    { title: 'look-alike of Amina\'s address: blocked, nothing signed', args: ['ask', `send 10 USDT to ${poison} for rent`, '--yes'], expect: [/address-poisoning/], refuse: [/Signed on this device|Imesainiwa/] },
    { title: 'no amount said: nothing signed', args: ['ask', 'tuma kwa Otieno', '--yes'], expect: [], refuse: [/Signed on this device|Imesainiwa/] },
    { title: 'Swahili prize-scam SMS: high risk', args: ['check', 'Umeshinda zawadi ya USDT 500! Lipa ada ya usajili 20 USDT ndani ya saa 1 ili kupokea.'], expect: [/HATARI KUBWA/] },
    { title: 'outbox: the two signed payments, waiting for a network', args: ['queue'], expect: [/^queued/m], count: { re: /^queued /gm, n: 2 } },
    { title: 'the two offline signatures: signer recovered from the raw bytes = this test wallet (no key, no network)', script: 'scripts/verify_outbox.mjs', args: ['--network', 'devnet', '--expect', '2'], expect: [/2 queued signature\(s\) checked .*, 0 bad/] }
  ]
  const results = []
  for (const [i, s] of steps.entries()) {
    console.log(`\n=== ${i + 1}/${steps.length} ${s.title}`)
    const r = await run(s.script || 'bin/sauti.mjs', s.args, env, { capture: true })
    const bad = []
    if (r.code !== 0) bad.push(`exit ${r.code}`)
    for (const re of s.expect) if (!re.test(r.out)) bad.push(`missing ${re}`)
    for (const re of s.refuse || []) if (re.test(r.out)) bad.push(`unexpected ${re}`)
    if (s.count && (r.out.match(s.count.re) || []).length !== s.count.n) bad.push(`expected ${s.count.n} queued payments`)
    results.push({ step: s.title, ok: !bad.length, bad })
    if (bad.length) console.log(`--- FAIL: ${bad.join('; ')}`)
    if (/refusing to (start|sign)/.test(r.out)) break // the network came back: stop at once
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.map((r, i) => `${r.ok ? 'ok  ' : 'FAIL'} ${i + 1}. ${r.step}`).join('\n')}`)
  console.log(failed.length || results.length !== steps.length ? '\nPORTABLE DEMO FAIL' : `\nPORTABLE DEMO PASS: signed offline, still in the outbox: ${DEMO_DATA}/queue/devnet/ (test tokens; never broadcast in portable mode)`)
  process.exit(failed.length || results.length !== steps.length ? 1 : 0)
}

async function main () {
  const [cmd, ...args] = ARGV
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) { console.log(USAGE); return }
  const bad = startProblem()
  if (bad) { console.error(`refusing to start: ${bad}`); process.exit(2) }
  if (cmd === 'probe') return cmdProbe()
  if (!['ui', 'demo', ...CLI_COMMANDS].includes(cmd)) { console.error(`unknown command "${String(cmd).slice(0, 40)}"\n\n${USAGE}`); process.exit(2) }
  await gateOrExit()
  const problem = preflight(cmd, args) || envProblem()
  if (problem) { console.error(`cannot run: ${problem}`); process.exit(2) }
  if (cmd === 'ui') return cmdUi()
  if (cmd === 'demo') return cmdDemo()
  const r = await run('bin/sauti.mjs', [cmd, ...args], childEnv())
  process.exit(r.code)
}

// SAUTI_DATA and the private temp folder, checked once before any child starts (a clear message instead of a crash)
function envProblem () {
  try { dataFromEnv(); if (process.platform !== 'win32') tmpCache = privateTmp(); return null } catch (e) { return e.message }
}

main().catch((e) => { console.error(`portable: ${e.message}`); process.exit(1) })
