// The run gate: may this process load the AI, open the wallet and sign? Node built-ins only, because the launchers
// (bin/sauti.mjs, bin/serve.mjs) call it BEFORE any third-party package is loaded.
//
// Two modes can pass, and both need the same live network probe (src/offline.js) to report everything unreachable:
//   offline   set only by ops/sandbox.sh (bubblewrap --unshare-net, Linux). The default path, unchanged.
//   portable  set by the portable launcher (bin/portable.mjs: `npm run portable -- <command>`), for a laptop without
//             bubblewrap (macOS, Windows, Linux). There is no sandbox: the person switches the network off, and the
//             probe proves it at startup and again right before every signature.
// Any other value (or none) is refused, as before. The probe fails closed: an error or a malformed answer refuses.
import { networkProof } from './offline.js'

export const RUN_MODES = Object.freeze(['offline', 'portable'])
export const PORTABLE_HINT = 'Turn Wi-Fi/Ethernet off, then run again.'

/** The probe legs that reached something, as short labels (empty when everything failed). */
export function reachable (p) {
  const out = []
  if (!p || typeof p !== 'object') return ['probe gave no answer']
  if (p.tcp_ipv4?.ok === true) out.push(`tcp ${p.tcp_ipv4.target || 'IPv4'} connected`)
  if (p.tcp_ipv6?.ok === true) out.push('tcp IPv6 connected')
  if (p.dns?.ok === true) out.push(`dns ${p.dns.target || 'lookup'} resolved`)
  // a probe that says online without saying why, or does not say "offline" at all, still counts as online
  if (!out.length && p.online !== false) out.push('network state unknown')
  return out
}

/**
 * @param {{env?: object, probe?: () => Promise<object>, action?: 'start'|'sign'|'run', launcher?: string}} o
 *   action: what is about to happen ("start" a launcher, "sign" a payment, "run" an AI request in the engine);
 *   launcher: the sandbox command to suggest when the mode is missing.
 * @returns {Promise<{ok: boolean, mode: string, code: string, message: string, proof: object|null}>}
 */
export async function checkGate ({ env = process.env, probe = networkProof, action = 'start', launcher = 'node bin/sauti.mjs ...' } = {}) {
  const mode = typeof env.SAUTI_SANDBOX === 'string' ? env.SAUTI_SANDBOX : ''
  const verb = action === 'sign' ? 'refusing to sign' : action === 'run' ? 'refusing to run this request' : 'refusing to start'
  if (!RUN_MODES.includes(mode)) {
    return {
      ok: false,
      mode: mode || 'none',
      code: 'no_sandbox',
      proof: null,
      message: `${verb}: run it inside the offline sandbox (ops/sandbox.sh offline ${launcher}), or on a laptop without ` +
        `bubblewrap with the network switched off: npm run portable -- <command> (see JUDGES.md)`
    }
  }
  let p = null
  try { p = await probe() } catch (e) { p = { online: true, error: String(e?.message || e).slice(0, 80) } }
  const hits = reachable(p)
  if (hits.length) {
    const why = hits.join(', ')
    return {
      ok: false,
      mode,
      code: 'online',
      proof: p,
      message: mode === 'portable'
        ? `${verb}: the internet is reachable from this computer (${why}). ${PORTABLE_HINT}`
        : `${verb}: the internet is reachable from this process (${why})`
    }
  }
  return { ok: true, mode, code: 'offline', proof: p, message: 'network: OFF (verified: no route, no DNS)' }
}

/** Throws (message = the refusal) unless the gate passes. For the signing steps of the CLI and the engine. */
export async function requireGate (o = {}) {
  const g = await checkGate(o)
  if (!g.ok) { const e = new Error(g.message); e.gate = g; throw e }
  return g
}
