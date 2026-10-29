// Where the engine listens and the bridge connects. Node built-ins only (the bridge has no dependencies).
// - Linux / macOS: a Unix socket at <data>/run/engine.sock (tmp/run/engine.sock by default), mode 0600 in a 0700
//   directory, exactly as before.
// - Windows (portable mode only): Node implements local sockets as named pipes there. The portable launcher picks a
//   random pipe name for each start (SAUTI_ENGINE_PIPE = \\.\pipe\sauti-pesa-<32 hex>) and gives it to the engine and
//   the bridge only; nothing else is accepted.
import { join } from 'node:path'

export const PIPE_RE = /^\\\\\.\\pipe\\sauti-pesa-[0-9a-f]{32}$/
// sun_path holds 104 bytes on macOS and 108 on Linux, including the final NUL
const maxSocketBytes = (platform) => (platform === 'darwin' ? 103 : 107)

/**
 * @returns {{path: string, pipe: boolean}}
 */
export function engineSocket ({ root, data, env = process.env, platform = process.platform }) {
  if (platform === 'win32') {
    const p = String(env.SAUTI_ENGINE_PIPE || '')
    if (!PIPE_RE.test(p)) throw new Error('on Windows, start the app with: npm run portable -- ui')
    return { path: p, pipe: true }
  }
  const path = join(data === root ? join(root, 'tmp') : data, 'run', 'engine.sock')
  const n = Buffer.byteLength(path)
  const max = maxSocketBytes(platform)
  if (n > max) {
    throw new Error(`the project folder path is too long for a local socket (${n} bytes for ${path}; the limit is ` +
      `${max}): move the project to a shorter path, for example ~/sauti-pesa`)
  }
  return { path, pipe: false }
}

/**
 * The UI port from SAUTI_UI_PORT (default 8787): plain decimal digits only, 1024-65535. One rule for the bridge, which
 * listens on it, and the portable launcher, which prints the link (so "0x2000" or " 8787" can never make the two disagree).
 * @returns {number}
 */
export function uiPort (env = process.env) {
  const raw = env.SAUTI_UI_PORT
  const s = raw === undefined || raw === '' ? '8787' : String(raw)
  const n = /^[0-9]{4,5}$/.test(s) ? Number(s) : NaN
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('SAUTI_UI_PORT must be a number from 1024 to 65535')
  return n
}
