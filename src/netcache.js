// The engine's live network proof (src/offline.js), in two flavours:
// - fresh():  probes NOW, every call, never a cached answer. The run gate uses only this one (engine start, right
//             before every signature, and in portable mode before every AI request).
// - cached(): the last answer when it is younger than maxAgeMs, for the status pill only (the page polls it).
//             The age is measured on a MONOTONIC clock (performance.now()), never the wall clock: a clock that steps
//             back (an NTP correction after the network returns) or stands still cannot keep an old "offline" alive.
// Node built-ins only.
import { performance } from 'node:perf_hooks'
import { networkProof } from './offline.js'

/**
 * @param {{probe?: () => Promise<object>, now?: () => number}} o  probe: the live probe; now: monotonic milliseconds
 */
export function proofSource ({ probe = networkProof, now = () => performance.now() } = {}) {
  let last = null // { p, t }
  async function fresh () {
    const p = await probe()
    last = { p, t: now() }
    return p
  }
  async function cached (maxAgeMs = 5000) {
    if (last) {
      const age = now() - last.t
      if (Number.isFinite(age) && age >= 0 && age <= maxAgeMs) return last.p
    }
    return fresh()
  }
  return { fresh, cached, get last () { return last ? last.p : null } }
}
