// Portable-mode hardening (security review of 2026-10-29), each with a positive control where one is possible:
//   M1  the engine's gate probes FRESH every time; only the status pill uses a cache, timed on a monotonic clock
//   L1  only "no network" error codes count as offline; a refused/reset connection or an unknown error is ONLINE
//   L2  the launcher's children get an allowlisted environment; NODE_OPTIONS / node flags refuse to start
//   L3  Linux/macOS children get a private 0700 TMPDIR for QVAC's worker socket (socket path length checked)
//   L5  Windows wallet init restricts the private folder with icacls (stubbed platform) or writes no seed
//   +   one rule for SAUTI_UI_PORT in the bridge and the launcher
// Controls against the reviewed commit (47ad420) load its files from git history; they are skipped without git.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, chmodSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkGate, reachable } from '../src/gate.js'
import { legOffline, networkProof, OFFLINE_TCP_ERRORS, OFFLINE_DNS_ERRORS, PROBE_LEGS, TARGETS } from '../src/offline.js'
import { proofSource } from '../src/netcache.js'
import { uiPort } from '../src/sockpath.js'
import { PASS_ENV, childEnvFrom, startProblem, dataFromEnv, privateTmp } from '../src/launch_env.js'
import { restrictPrivateDir, createWallet } from '../src/wallet.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REVIEWED = '47ad420'
const scratch = mkdtempSync(join(ROOT, 'tmp', 'harden-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

// the reviewed commit's version of some files, written to a scratch folder (null when git or the commit is missing)
function reviewed (files) {
  const dir = mkdtempSync(join(scratch, 'old-'))
  for (const f of files) {
    const r = spawnSync('git', ['show', `${REVIEWED}:${f}`], { cwd: ROOT, encoding: 'utf8' })
    if (r.status !== 0) return null
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), r.stdout)
  }
  return dir
}

// an all-offline probe as the bubblewrap sandbox reports it (Linux): no route, no DNS server
const off = () => ({
  online: false,
  sandbox: 'portable',
  interfaces: ['lo'],
  tcp_ipv4: { target: '1.1.1.1:443', ok: false, error: 'ENETUNREACH', ms: 1 },
  tcp_ipv6: { target: '[2606:4700:4700::1111]:443', ok: false, error: 'ENETUNREACH', ms: 1 },
  dns: { target: 'huggingface.co', ok: false, error: 'EAI_AGAIN' },
  dns2: { target: 'example.com', ok: false, error: 'EAI_AGAIN' },
  at: new Date().toISOString()
})
const portable = (probe, action = 'sign') => checkGate({ env: { SAUTI_SANDBOX: 'portable' }, action, probe })

// ------------------------------------------------------------------------------------------------------------ M1
test('M1 control: the reviewed proof cache (wall clock) lets a sign through while online', async () => {
  // src/engine.js at 47ad420, lines 101-110, verbatim except for the injected clock and probe
  let wall = Date.parse('2026-10-29T10:00:00.000Z')
  let online = false
  const networkProof = async () => ({ ...off(), online, tcp_ipv4: { target: '1.1.1.1:443', ok: online, ...(online ? {} : { error: 'ENETUNREACH' }) }, at: new Date(wall).toISOString() })
  let proofCache = null
  const now = () => wall
  async function proof (maxAgeMs = 5000) {
    if (!proofCache || now() - Date.parse(proofCache.at) > maxAgeMs) proofCache = await networkProof()
    return proofCache
  }
  const gate = (action) => portable(() => proof(0), action)
  assert.equal((await gate('sign')).ok, true) // offline: fine
  online = true
  assert.equal((await gate('sign')).ok, true, 'same millisecond: the old cache answers "offline" while online')
  online = false; wall += 10; await gate('sign')
  online = true; wall -= 30000 // the clock steps back (NTP after the network returns)
  assert.equal((await gate('sign')).ok, true, 'clock stepped back: old cache passes')
  assert.equal((await gate('run')).ok, true)
})

test('M1: the gate probe is fresh on every call, whatever the wall clock does', async () => {
  const realNow = Date.now
  let wall = Date.parse('2026-10-29T10:00:00.000Z')
  Date.now = () => wall
  try {
    let online = false
    let calls = 0
    const probe = async () => { calls++; return online ? { ...off(), online: true, tcp_ipv4: { target: '1.1.1.1:443', ok: true } } : off() }
    const probes = proofSource({ probe, now: () => 0 }) // a monotonic clock that stands still: the gate must not care
    const gate = (action) => portable(probes.fresh, action)
    assert.equal((await gate('sign')).ok, true)
    online = true
    const same = await gate('sign') // same millisecond
    assert.equal(same.ok, false)
    assert.match(same.message, /^refusing to sign: the internet is reachable from this computer \(tcp 1\.1\.1\.1:443 connected\)/)
    online = false; wall += 10; await gate('sign')
    online = true; wall -= 30000
    assert.equal((await gate('sign')).ok, false, 'clock stepped back')
    assert.equal((await gate('run')).ok, false)
    wall += 29000
    assert.equal((await gate('sign')).ok, false)
    assert.equal(calls, 6, 'one live probe per gate call')
    // and the status pill sees what the gate saw last
    assert.equal(probes.last.online, true)
  } finally { Date.now = realNow }
})

test('M1: the status-pill cache uses the monotonic clock only, and refreshes on any odd age', async () => {
  let t = 1000
  let n = 0
  const probes = proofSource({ probe: async () => ({ n: ++n }), now: () => t })
  assert.equal((await probes.cached(5000)).n, 1)
  t += 4999
  assert.equal((await probes.cached(5000)).n, 1, 'young enough: cached')
  const realNow = Date.now
  Date.now = () => 0 // a wall clock far in the past changes nothing
  try { assert.equal((await probes.cached(5000)).n, 1) } finally { Date.now = realNow }
  t += 2
  assert.equal((await probes.cached(5000)).n, 2, 'older than 5 s: probed again')
  t -= 10 // a monotonic clock never goes back; if it did, do not trust the cache
  assert.equal((await probes.cached(5000)).n, 3)
  t = NaN
  assert.equal((await probes.cached(5000)).n, 4)
  assert.equal((await probes.fresh()).n, 5)
})

test('M1: the engine gates with probes.fresh (start, every signature, every portable AI request); no wall-clock cache', () => {
  const src = readFileSync(join(ROOT, 'src/engine.js'), 'utf8')
  const gate = src.slice(src.indexOf('async function gate (action) {'), src.indexOf('\n}\n', src.indexOf('async function gate (action) {')))
  assert.match(gate, /checkGate\(\{ action, launcher: 'node bin\/serve\.mjs', probe: probes\.fresh \}\)/)
  const start = src.slice(src.indexOf('async function start () {'))
  assert.match(start.slice(0, 600), /checkGate\(\{ launcher: 'node bin\/serve\.mjs', probe: probes\.fresh \}\)/)
  assert.equal((src.match(/checkGate\(/g) || []).length, 2, 'only these two gates')
  assert.ok(!/Date\.parse\(/.test(src), 'no wall-clock cache')
  assert.ok(!/proof\(0\)|proofCache/.test(src))
  assert.match(src, /net: await probes\.cached\(5000\)/)
  assert.ok(!/from '\.\/offline\.js'/.test(src), 'the engine reaches the probe only through src/netcache.js')
  // every signing route goes through gate('sign'); every other non-light route through gate('run') in portable mode
  assert.equal((src.match(/await gate\('sign'\)/g) || []).length, 2)
  assert.match(src, /if \(PORTABLE && !route\.signs\) await gate\('run'\)/)
})

// ------------------------------------------------------------------------------------------------------------ L1
const tcpErr = (error) => ({ ...off(), online: false, tcp_ipv4: { target: '1.1.1.1:443', ok: false, error } })

test('L1 control: the reviewed gate counts a refused / reset / unknown TCP error as "no network"', async (t) => {
  const dir = reviewed(['src/gate.js', 'src/offline.js'])
  if (!dir) return t.skip('git history not available')
  const old = await import(pathToFileURL(join(dir, 'src/gate.js')).href)
  for (const e of ['ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EWHATEVER']) {
    const p = tcpErr(e)
    delete p.dns2
    const g = await old.checkGate({ env: { SAUTI_SANDBOX: 'portable' }, action: 'sign', probe: async () => p })
    assert.equal(g.ok, true, `${e} passed the reviewed gate`)
  }
})

test('L1: a refused or reset connection, or any unknown error, counts as ONLINE', async () => {
  for (const e of ['ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EPERM', 'EPIPE', 'ETIMEDOUT', 'EWHATEVER', '', undefined]) {
    const g = await portable(async () => tcpErr(e))
    assert.equal(g.ok, false, String(e))
    assert.equal(g.code, 'online')
    if (e === 'ECONNREFUSED') assert.match(g.message, /\(tcp 1\.1\.1\.1:443 answered \(ECONNREFUSED\)\)/)
    if (e === 'EACCES') assert.match(g.message, /tcp 1\.1\.1\.1:443 failed with EACCES, which does not mean "no network"/)
  }
  // the same on the IPv6 leg
  for (const e of ['ECONNREFUSED', 'ECONNRESET', 'EPERM']) {
    const g = await portable(async () => ({ ...off(), tcp_ipv6: { target: '[2606:4700:4700::1111]:443', ok: false, error: e } }))
    assert.equal(g.ok, false, e)
    assert.match(g.message, /tcp IPv6 /)
  }
})

test('L1: only the documented "no network" codes pass, per leg kind', async () => {
  assert.deepEqual([...OFFLINE_TCP_ERRORS], ['ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'TIMEOUT'])
  assert.deepEqual([...OFFLINE_DNS_ERRORS], ['EAI_AGAIN', 'ENOTFOUND'])
  assert.deepEqual([...PROBE_LEGS], ['tcp_ipv4', 'tcp_ipv6', 'dns', 'dns2'])
  for (const e of OFFLINE_TCP_ERRORS) {
    assert.equal((await portable(async () => tcpErr(e))).ok, true, e)
    assert.equal(legOffline('tcp_ipv6', { ok: false, error: e }), true)
  }
  // no IPv6 stack at all: the IPv6 leg cannot reach anything; the IPv4 leg never says that
  assert.equal(legOffline('tcp_ipv6', { ok: false, error: 'EAFNOSUPPORT' }), true)
  assert.equal(legOffline('tcp_ipv4', { ok: false, error: 'EAFNOSUPPORT' }), false)
  // DNS: no server reachable (Linux), or "no such name" as macOS / Windows report a lookup without a network
  for (const e of OFFLINE_DNS_ERRORS) {
    assert.equal((await portable(async () => ({ ...off(), dns: { target: 'huggingface.co', ok: false, error: e }, dns2: { target: 'example.com', ok: false, error: e } }))).ok, true, e)
  }
  // a resolver that answers with a failure, or a TCP code on a DNS leg, is not proof of "no network"
  for (const e of ['EAI_FAIL', 'ESERVFAIL', 'ECONNREFUSED', 'ENETUNREACH', 'TIMEOUT']) {
    assert.equal((await portable(async () => ({ ...off(), dns2: { target: 'example.com', ok: false, error: e } }))).ok, false, e)
  }
  for (const [name, leg] of [['dns', { ok: true }], ['nope', { ok: false, error: 'ENETUNREACH' }], ['tcp_ipv4', null], ['tcp_ipv4', { ok: false }], ['tcp_ipv4', { ok: 'false', error: 'ENETUNREACH' }]]) {
    assert.equal(legOffline(name, leg), false, `${name} ${JSON.stringify(leg)}`)
  }
})

test('L1: the second DNS name counts, and a probe without it fails closed', async () => {
  assert.equal(TARGETS.dns, 'huggingface.co')
  assert.equal(TARGETS.dns2, 'example.com')
  const g = await portable(async () => ({ ...off(), dns2: { target: 'example.com', ok: true } }))
  assert.equal(g.ok, false)
  assert.match(g.message, /\(dns example\.com resolved\)/)
  const p = off()
  delete p.dns2
  const h = await portable(async () => p)
  assert.equal(h.ok, false)
  assert.match(h.message, /dns lookup gave no answer/)
  assert.deepEqual(reachable(off()), [])
  // the hosts-file flip used by test/e2e_portable.sh still reads exactly as before
  assert.deepEqual(reachable({ ...off(), dns: { target: 'huggingface.co', ok: true } }), ['dns huggingface.co resolved'])
})

test('L1: the live probe marks every leg, and "online" is exactly "some leg is not offline"', async () => {
  const p = await networkProof()
  for (const k of PROBE_LEGS) assert.equal(typeof p[k].offline, 'boolean', k)
  assert.equal(p.online, PROBE_LEGS.some((k) => !p[k].offline))
  assert.equal(p.online, reachable(p).length > 0)
})

// ------------------------------------------------------------------------------------------------------------ L2
test('L2: NODE_OPTIONS or node flags on the launcher refuse to start (they run code before our checks)', () => {
  assert.equal(startProblem({ env: {}, execArgv: [] }), null)
  assert.equal(startProblem({ env: { NODE_OPTIONS: '' }, execArgv: [] }), null)
  assert.match(startProblem({ env: { NODE_OPTIONS: '--require ./evil.cjs' }, execArgv: [] }), /^NODE_OPTIONS is set/)
  assert.match(startProblem({ env: {}, execArgv: ['--import', 'x.mjs'] }), /^node was started with extra flags \(--import x\.mjs\)/)
  const canary = join(scratch, 'canary.cjs')
  const marker = join(scratch, 'canary-ran.txt')
  writeFileSync(canary, `require('fs').appendFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join(' ') + '\\n')\n`)
  const env = { ...process.env, NODE_OPTIONS: `--require ${canary}` }
  delete env.SAUTI_SANDBOX
  for (const [argv, e] of [[['bin/portable.mjs', 'queue'], env], [['--require', canary, 'bin/portable.mjs', 'probe'], { ...env, NODE_OPTIONS: '' }]]) {
    const r = spawnSync(process.execPath, argv, { cwd: ROOT, env: e, encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /^refusing to start: (NODE_OPTIONS is set|node was started with extra flags)/)
  }
  // the canary ran only in the launcher itself (unavoidable: node loads it first), never in a child
  const ran = readFileSync(marker, 'utf8').trim().split('\n')
  assert.equal(ran.length, 2)
  for (const line of ran) assert.match(line, /bin\/portable\.mjs/)
})

test('L2: the children\'s environment is an allowlist; injection variables and other secrets never pass', () => {
  const src = {
    PATH: '/usr/bin:/bin', LANG: 'sw_KE.UTF-8', TERM: 'xterm', TEMP: 'C:\\Users\\j\\AppData\\Local\\Temp', TMP: 'C:\\T', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATHEXT: '.COM;.EXE', APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L',
    NODE_OPTIONS: '--require /x.cjs', QVAC_WORKER_PATH: '/evil/worker.js', LD_PRELOAD: '/evil.so', LD_LIBRARY_PATH: '/evil', DYLD_INSERT_LIBRARIES: '/evil.dylib',
    DYLD_LIBRARY_PATH: '/evil', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_EXTRA_CA_CERTS: '/evil.pem', SSL_CERT_FILE: '/evil.pem', HTTPS_PROXY: 'http://evil:3128',
    GITHUB_TOKEN: 'not-a-token', AWS_SECRET_ACCESS_KEY: 'x', npm_config_registry: 'http://evil', SAUTI_SANDBOX: 'offline', SAUTI_UI_TOKEN: 'k'.repeat(43),
    SAUTI_ENGINE_PIPE: '\\\\.\\pipe\\x', SAUTI_QUEUE_LOCKED: '1', SAUTI_DATA: '/etc', SAUTI_UPLOAD_TIMEOUT_MS: '1', HOME: '/home/real', USERPROFILE: 'C:\\Users\\real', BAD: 'a\0b'
  }
  const env = childEnvFrom(src, { home: '/p/home', tmp: '/p/tmp/pt', data: 'tmp/x', extra: { SAUTI_ENGINE_PIPE: 'pipe-ok', SAUTI_UI_TOKEN: 'tok', LD_PRELOAD: '/still/no', NODE_OPTIONS: '--x' } })
  assert.deepEqual(Object.keys(env).sort(), [...PASS_ENV, 'HOME', 'USERPROFILE', 'TMPDIR', 'NODE_ENV', 'SAUTI_DATA', 'SAUTI_ENGINE_PIPE', 'SAUTI_UI_TOKEN', 'SAUTI_SANDBOX'].sort())
  for (const k of PASS_ENV) assert.equal(env[k], src[k], k)
  assert.equal(env.HOME, '/p/home')
  assert.equal(env.USERPROFILE, '/p/home', 'Windows: QVAC\'s .qvac follows USERPROFILE')
  assert.equal(env.TMPDIR, '/p/tmp/pt')
  assert.equal(env.SAUTI_SANDBOX, 'portable')
  assert.equal(env.SAUTI_DATA, 'tmp/x', 'only the checked form')
  assert.equal(env.SAUTI_UI_TOKEN, 'tok', 'only when the launcher gives it (the bridge)')
  const plain = childEnvFrom({ PATH: '/bin', SAUTI_UI_TOKEN: 'k'.repeat(43), PATHEXT: '' }, { home: '/h' })
  assert.deepEqual(Object.keys(plain).sort(), ['HOME', 'NODE_ENV', 'PATH', 'SAUTI_SANDBOX', 'USERPROFILE'])
})

test('L2: SAUTI_DATA must be tmp/<name> inside the project (the engine and sandbox rule)', () => {
  assert.equal(dataFromEnv({}), null)
  assert.equal(dataFromEnv({ SAUTI_DATA: '' }), null)
  assert.equal(dataFromEnv({ SAUTI_DATA: 'tmp/portable-demo' }), 'tmp/portable-demo')
  assert.equal(dataFromEnv({ SAUTI_DATA: join(ROOT, 'tmp', 'e2e-x', 'data') }), 'tmp/e2e-x/data')
  assert.equal(dataFromEnv({ SAUTI_DATA: 'tmp/a/../b' }), 'tmp/b')
  for (const bad of ['/etc', 'private', 'tmp', 'tmp/', 'tmp/../private', '../x', 'tmp/.hidden', 'tmp/a b', 'tmp/a/b/c/d/e', `tmp/${'\u00e9'}`]) {
    assert.throws(() => dataFromEnv({ SAUTI_DATA: bad }), /SAUTI_DATA must be tmp\/<name>/, bad)
  }
})

// ------------------------------------------------------------------------------------------------------------ L3
test('L3: QVAC still names its worker socket in os.tmpdir() as we assume (39 bytes incl. the slash)', (t) => {
  const f = join(ROOT, 'node_modules/@qvac/sdk/dist/src/client/rpc/node-rpc-client.js')
  if (!existsSync(f)) return t.skip('node_modules not installed')
  const src = readFileSync(f, 'utf8')
  assert.match(src, /const socketName = `qvac-worker-\$\{process\.pid\}-\$\{timestamp\}-\$\{randomSuffix\}`;/)
  assert.match(src, /const timestamp = Date\.now\(\)\.toString\(36\);/)
  assert.match(src, /const randomSuffix = randomBytes\(2\)\.toString\('hex'\);/)
  assert.match(src, /: path\.join\(os\.tmpdir\(\), `\$\{socketName\}\.sock`\);/)
  assert.equal(`/qvac-worker-${4194304}-${Date.now().toString(36)}-ffff.sock`.length, 39)
})

test('L3: the children\'s TMPDIR is a private 0700 folder of this account; too-long paths fall back only to a private one', (t) => {
  const none = { systemTmp: '/tmp', runtimeDir: '' } // /tmp is shared (root, 1777): never a fallback
  const dir = join(scratch, 'pt')
  assert.equal(privateTmp({ dir, platform: 'linux', ...none }), dir)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  chmodSync(dir, 0o755)
  privateTmp({ dir, platform: 'linux', ...none })
  assert.equal(statSync(dir).mode & 0o777, 0o700, 'made private again')
  // a link in its place is refused
  const link = join(scratch, 'pt-link')
  symlinkSync(dir, link)
  assert.throws(() => privateTmp({ dir: link, platform: 'linux', ...none }), /not a plain folder of this account/)
  // too long for the socket (Linux 107 - 39 = 68 bytes, macOS 103 - 39 = 64)
  const long = join(scratch, 'x'.repeat(Math.max(1, 69 - Buffer.byteLength(scratch) - 1)))
  assert.ok(Buffer.byteLength(long) >= 69)
  assert.throws(() => privateTmp({ dir: long, platform: 'linux', ...none }), /too long for QVAC's local socket .*move the project to a shorter path/)
  assert.equal(existsSync(long), false)
  const own = mkdtempSync('/tmp/sp-pt-') // short and private (0700, ours): what macOS gives each account, or XDG_RUNTIME_DIR
  try {
    chmodSync(own, 0o700)
    assert.equal(privateTmp({ dir: long, platform: 'linux', systemTmp: own, runtimeDir: '' }), realpathSync(own))
    assert.equal(privateTmp({ dir: long, platform: 'linux', systemTmp: '/tmp', runtimeDir: own }), realpathSync(own))
    chmodSync(own, 0o755) // readable by others: not used
    assert.throws(() => privateTmp({ dir: long, platform: 'linux', systemTmp: own, runtimeDir: own }), /too long/)
  } finally { rmSync(own, { recursive: true, force: true }) }
  const at64 = join(scratch, 'y'.repeat(64 - Buffer.byteLength(scratch) - 1))
  if (Buffer.byteLength(at64) !== 64) return t.skip('scratch path too long for the boundary check')
  assert.equal(privateTmp({ dir: at64, platform: 'darwin', ...none }), at64, 'macOS: 64 bytes fit')
  assert.throws(() => privateTmp({ dir: `${at64}z`, platform: 'darwin', ...none }), /the limit is 64/)
})

// ------------------------------------------------------------------------------------------------------------ L5
test('L5: Windows wallet init restricts the private folder with icacls (by SID, else user name), or writes no seed', async () => {
  const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001'
  const calls = []
  const stub = ({ whoami = { status: 0, stdout: `"desktop-x\\judge","${SID}"\r\n` }, icacls = { status: 0 } } = {}) => (exe, argv, o) => {
    calls.push({ exe, argv, o })
    if (/whoami\.exe$/.test(exe)) return typeof whoami === 'function' ? whoami() : whoami
    return typeof icacls === 'function' ? icacls() : icacls
  }
  assert.deepEqual(restrictPrivateDir('/p/private', { platform: 'linux', run: stub() }), { method: 'posix-modes' })
  assert.deepEqual(restrictPrivateDir('/p/private', { platform: 'darwin', run: stub() }), { method: 'posix-modes' })
  assert.equal(calls.length, 0, 'POSIX: unchanged, nothing run')
  const dir = 'C:\\Users\\judge\\sauti-pesa\\private'
  const r = restrictPrivateDir(dir, { platform: 'win32', run: stub(), env: { SystemRoot: 'D:\\Win' }, user: () => 'judge' })
  assert.equal(r.method, 'icacls')
  assert.equal(calls[0].exe, 'D:\\Win\\System32\\whoami.exe')
  assert.deepEqual(calls[0].argv, ['/user', '/fo', 'csv', '/nh'])
  assert.equal(calls[1].exe, 'D:\\Win\\System32\\icacls.exe')
  assert.deepEqual(calls[1].argv, [dir, '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`])
  assert.ok(calls.every((c) => c.o.shell === false))
  // whoami unusable: the user name instead
  for (const whoami of [{ status: 1, stdout: '' }, { status: 0, stdout: 'garbage' }, { status: 0, stdout: '"x","S-1-5-21-1-2;del"' }, () => { throw new Error('ENOENT') }, null]) {
    calls.length = 0
    restrictPrivateDir(dir, { platform: 'win32', run: stub({ whoami }), env: {}, user: () => 'judge' })
    assert.deepEqual(calls.at(-1).argv, [dir, '/inheritance:r', '/grant:r', 'judge:(OI)(CI)F'], JSON.stringify(whoami))
  }
  // a SystemRoot that is not a plain drive path is not trusted
  for (const bad of ['\\\\evil\\share', 'icacls', '', undefined, 'C:\\a"b']) {
    restrictPrivateDir(dir, { platform: 'win32', run: stub(), env: { SystemRoot: bad }, user: () => 'judge' })
    assert.equal(calls.at(-1).exe, 'C:\\Windows\\System32\\icacls.exe', String(bad))
  }
  for (const icacls of [{ status: 5 }, { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }, null]) {
    assert.throws(() => restrictPrivateDir(dir, { platform: 'win32', run: stub({ icacls }), env: {}, user: () => 'judge' }), /refusing to write the seed/)
  }
  for (const name of ['', 'a"b', 'a\nb', 'x'.repeat(105)]) {
    assert.throws(() => restrictPrivateDir(dir, { platform: 'win32', run: stub({ whoami: { status: 1 } }), env: {}, user: () => name }), /could not tell which Windows account/)
  }
  // through createWallet: a failed restriction leaves no seed behind; a working one runs BEFORE the seed is written
  const wdir = mkdtempSync(join(scratch, 'w-'))
  const file = join(wdir, 'private', 'wallet.json')
  await assert.rejects(createWallet(file, { platform: 'win32', run: stub({ icacls: { status: 1 } }), env: {}, user: () => 'judge' }), /refusing to write the seed/)
  assert.equal(existsSync(file), false)
  let seenBefore = null
  const addr = await createWallet(file, { platform: 'win32', run: stub({ icacls: () => { seenBefore = existsSync(file); return { status: 0 } } }), env: {}, user: () => 'judge' })
  assert.match(addr, /^0x[0-9a-fA-F]{40}$/)
  assert.equal(seenBefore, false)
  assert.equal(calls.at(-1).argv[0], join(wdir, 'private'))
})

// ------------------------------------------------------------------------------------------------------------ port
test('UI port: one strict rule (decimal 1024-65535) in the bridge and the launcher', () => {
  assert.equal(uiPort({}), 8787)
  assert.equal(uiPort({ SAUTI_UI_PORT: '' }), 8787)
  assert.equal(uiPort({ SAUTI_UI_PORT: '8789' }), 8789)
  assert.equal(uiPort({ SAUTI_UI_PORT: '65535' }), 65535)
  for (const bad of ['0x2000', ' 8787', '8787 ', '8787.0', '1e4', '80', '1023', '65536', '-8787', '+8787', '08787x', 'abc', '99999']) {
    assert.throws(() => uiPort({ SAUTI_UI_PORT: bad }), /SAUTI_UI_PORT must be a number from 1024 to 65535/, bad)
  }
  const r = spawnSync(process.execPath, [join(ROOT, 'bin/bridge.mjs')], { env: { PATH: process.env.PATH, SAUTI_UI_TOKEN: 'k'.repeat(43), SAUTI_UI_PORT: '0x2000' }, encoding: 'utf8', timeout: 20000 })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /^refusing to start: SAUTI_UI_PORT must be a number from 1024 to 65535/)
  const src = readFileSync(join(ROOT, 'bin/portable.mjs'), 'utf8')
  assert.match(src, /port = uiPort\(process\.env\)/)
  // the link is printed from the bridge's "listening" line, not before
  const ui = src.slice(src.indexOf('async function cmdUi () {'), src.indexOf('// The offline flow end to end'))
  assert.ok(ui.indexOf('Open this link') > ui.indexOf("bridge.stdout.on('data'"), 'link printed only inside the listening handler')
  assert.match(readFileSync(join(ROOT, '.npmrc'), 'utf8'), /^update-notifier=false$/m)
})
