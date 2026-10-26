// Isolation probe. Run it on the host (positive control) and inside each sandbox mode; compare.
//   node ops/sandbox_probe.mjs [--port N ...]                          (host)
//   ops/sandbox.sh offline node ops/sandbox_probe.mjs [--port N ...]   (sandbox; also devnet / online)
// --port N: a TCP port of a local service on the host's 127.0.0.1 to try to reach (repeatable, optional).
// Prints one JSON line. It never prints file contents or names, only counts and booleans.
import { readdirSync, existsSync, writeFileSync, unlinkSync, openSync, closeSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { userInfo } from 'node:os'
import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'

const PROJECT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const REAL_HOME = userInfo().homedir // from /etc/passwd: the real home directory, even when $HOME is changed
const ports = []
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== '--port') { console.error('usage: sandbox_probe.mjs [--port N ...]'); process.exit(2) }
  const p = Number(process.argv[++i])
  if (!Number.isInteger(p) || p < 1 || p > 65535 || ports.length >= 8) { console.error('bad --port'); process.exit(2) }
  ports.push(p)
}
const count = (p) => { try { return readdirSync(p).length } catch { return -1 } }
// can a new file be created in this directory? (removed again at once)
const canCreate = (dir) => { const f = join(dir, `.probe_${process.pid}`); try { writeFileSync(f, 'x', { flag: 'wx' }); unlinkSync(f); return true } catch { return false } }
// can this existing file be opened for writing? (append mode, nothing is written, the content is unchanged)
const canOpenForWrite = (file) => { try { closeSync(openSync(file, constants.O_WRONLY | constants.O_APPEND)); return true } catch { return false } }
const tcp = (host, port) => new Promise((resolve) => {
  const s = connect({ host, port, timeout: 3000 })
  s.on('connect', () => { s.destroy(); resolve(true) })
  s.on('timeout', () => { s.destroy(); resolve(false) })
  s.on('error', () => resolve(false))
})
const https = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(6000) }); return r.status } catch (e) { return `fail:${e.cause?.code || e.name}` } }
// wallet files of test runs (tmp/<name>/private/wallet.json): only the offline signer may see them
const walletFilesUnder = (dir, depth = 4) => {
  let n = 0
  try {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isFile() && d.name === 'wallet.json') n++
      else if (d.isDirectory() && depth > 0) n += walletFilesUnder(join(dir, d.name), depth - 1)
    }
  } catch {}
  return n
}
const dns = async (h) => { try { await lookup(h); return true } catch { return false } }

const out = {
  where: process.env.SAUTI_SANDBOX || 'host',
  real_home_entries: count(REAL_HOME),
  ssh_dir_visible: existsSync(join(REAL_HOME, '.ssh')),
  project_parent_entries: count(dirname(PROJECT)), // a sandbox shows only the project itself
  run_entries: count('/run'),
  env_var_count: Object.keys(process.env).length,
  home: process.env.HOME === join(PROJECT, 'home') ? '<project>/home' : (process.env.HOME === REAL_HOME ? '<real home>' : 'other'),
  // what code in this process could change
  host_code_writable: canOpenForWrite(join(PROJECT, 'bin', 'bridge.mjs')) || canCreate(join(PROJECT, 'bin')) || canCreate(join(PROJECT, 'ops')),
  git_writable: canCreate(join(PROJECT, '.git')),
  tmp_writable: canCreate(join(PROJECT, 'tmp')),
  queue_writable: canCreate(join(PROJECT, 'queue')),
  // what it can see
  private_entries: count(join(PROJECT, 'private')),
  tmp_entries: count(join(PROJECT, 'tmp')),
  wallet_files_in_tmp: walletFilesUnder(join(PROJECT, 'tmp')),
  ...Object.fromEntries(await Promise.all(ports.map(async (p) => [`localhost_${p}_reachable`, await tcp('127.0.0.1', p)]))),
  direct_ip_1_1_1_1_443: await tcp('1.1.1.1', 443),
  dns_resolves: await dns('registry.npmjs.org'),
  internet_https: await https('https://registry.npmjs.org/-/ping'),
  ethereum_rpc_https: await https('https://ethereum-sepolia-rpc.publicnode.com')
}
console.log(JSON.stringify(out))
