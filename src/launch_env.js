// What the portable launcher (bin/portable.mjs) gives the processes it starts, and when it refuses to start at all.
// Node built-ins only: the launcher loads this before the gate, before any third-party package.
import { mkdirSync, lstatSync, chmodSync, realpathSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // project root (this file is in src/)

// The children's environment is rebuilt from this allowlist (the rest of the caller's environment is dropped: e.g.
// NODE_OPTIONS, QVAC_WORKER_PATH, LD_PRELOAD, DYLD_*, NODE_TLS_REJECT_UNAUTHORIZED, proxies, npm_*, tokens of other
// tools). The Windows names are what Node, Winsock and the QVAC worker need there; process.env lookups ignore case
// on Windows.
export const PASS_ENV = Object.freeze(['PATH', 'LANG', 'TERM', 'TEMP', 'TMP', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA'])
// "/qvac-worker-<pid>-<base36 ms>-<4 hex>.sock": QVAC 0.22 puts its worker socket in os.tmpdir() (node-rpc-client.js)
export const QVAC_SOCKET_NAME_MAX = 39
const PRIVATE_TMP = join(ROOT, 'tmp', 'pt')

/** Refuse when code could already run inside the launcher before its checks (NODE_OPTIONS, node flags). */
export function startProblem ({ env = process.env, execArgv = process.execArgv } = {}) {
  if (typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.trim() !== '') {
    return 'NODE_OPTIONS is set, and it can load code into this launcher before its checks run. Start it without: ' +
      'NODE_OPTIONS= node bin/portable.mjs <command>   (PowerShell: Remove-Item Env:NODE_OPTIONS; cmd: set NODE_OPTIONS=)'
  }
  if (execArgv.length > 0) return `node was started with extra flags (${execArgv.join(' ').slice(0, 80)}); run it as: node bin/portable.mjs <command>`
  return null
}

/** SAUTI_DATA, if set: tmp/<name> inside this project (the engine's and the sandbox's rule), as a relative path. */
export function dataFromEnv (env = process.env, root = ROOT) {
  const d = env.SAUTI_DATA
  if (d === undefined || d === '') return null
  const rel = relative(root, resolve(root, String(d))).split(sep).join('/')
  if (!/^tmp(\/[A-Za-z0-9_-][A-Za-z0-9._-]*){1,4}$/.test(rel)) throw new Error('SAUTI_DATA must be tmp/<name> inside this project')
  return rel
}

const ownedDir = (st) => st.isDirectory() && (typeof process.getuid !== 'function' || st.uid === process.getuid())

/**
 * Linux/macOS: the children's TMPDIR. A 0700 folder of our own in the project (tmp/pt), so QVAC's worker socket is
 * never in a temp folder shared with other accounts. If the project path is too long for that socket (sun_path: 108
 * bytes on Linux, 104 on macOS), a system temp folder is used only when it is already private to this account
 * (macOS: /var/folders/...; Linux: $XDG_RUNTIME_DIR); otherwise stop with the fix.
 */
export function privateTmp ({ dir = PRIVATE_TMP, platform = process.platform, systemTmp = tmpdir(), runtimeDir = process.env.XDG_RUNTIME_DIR } = {}) {
  const max = (platform === 'darwin' ? 103 : 107) - QVAC_SOCKET_NAME_MAX
  if (Buffer.byteLength(dir) <= max) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !ownedDir(st)) throw new Error(`${relative(ROOT, dir) || dir} is not a plain folder of this account; refusing to use it as the temp folder`)
    chmodSync(dir, 0o700)
    return dir
  }
  for (const cand of [systemTmp, runtimeDir]) {
    if (typeof cand !== 'string' || !cand) continue
    try {
      const real = realpathSync(cand)
      const st = lstatSync(real)
      if (ownedDir(st) && (st.mode & 0o077) === 0 && Buffer.byteLength(real) <= max) return real
    } catch {}
  }
  throw new Error(`the project folder path is too long for QVAC's local socket in a private temp folder (${Buffer.byteLength(dir)} bytes for ${dir}; ` +
    `the limit is ${max}), and the system temp folder is shared with other accounts: move the project to a shorter path, for example ~/sauti-pesa`)
}

/**
 * The children's environment, built from the launcher's own (pure: the tests pass a made-up one). Only PASS_ENV is
 * copied; HOME and USERPROFILE are the project's home/ (QVAC's ~/.qvac lands there, also on Windows); TMPDIR (Linux,
 * macOS) the private temp folder; SAUTI_DATA only in its checked form; the mode is always "portable".
 */
export function childEnvFrom (src, { home, tmp = null, data = null, extra = {} } = {}) {
  const env = {}
  for (const k of PASS_ENV) {
    const v = src[k]
    if (typeof v === 'string' && v !== '' && !v.includes('\0')) env[k] = v
  }
  env.HOME = home
  env.USERPROFILE = home
  if (tmp) env.TMPDIR = tmp
  env.NODE_ENV = 'production'
  if (data) env.SAUTI_DATA = data
  for (const [k, v] of Object.entries(extra)) if (['SAUTI_DATA', 'SAUTI_ENGINE_PIPE', 'SAUTI_UI_TOKEN', 'SAUTI_UI_PORT'].includes(k)) env[k] = String(v)
  env.SAUTI_SANDBOX = 'portable'
  return env
}
