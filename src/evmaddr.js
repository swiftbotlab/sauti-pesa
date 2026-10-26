// EVM address checks: format, EIP-55 checksum (catches single-character typos), and look-alike
// ("address poisoning") detection against addresses the person already trusts.
import { getAddress } from 'ethers'

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

export function normalizeAddress (a) {
  if (typeof a !== 'string' || !ADDR_RE.test(a.trim())) return { ok: false, error: 'not a 0x address of 40 hex characters' }
  const t = a.trim()
  const mixed = /[a-f]/.test(t.slice(2)) && /[A-F]/.test(t.slice(2))
  let checksummed
  try { checksummed = getAddress(t.toLowerCase()) } catch { return { ok: false, error: 'invalid address' } }
  if (mixed && checksummed !== t) return { ok: false, error: 'checksum does not match (a character is wrong)', code: 'bad_checksum' }
  if (/^0x0{40}$/i.test(t)) return { ok: false, error: 'zero address', code: 'zero_address' }
  return { ok: true, address: checksummed, checksumVerified: mixed }
}

/**
 * How visually similar two DIFFERENT addresses are, the way people compare them: by the first and
 * last characters. Poisoning attacks generate vanity addresses that match both ends.
 */
export function lookalike (a, b) {
  const x = a.toLowerCase(); const y = b.toLowerCase()
  if (x === y) return null
  let pre = 0; while (pre < 40 && x[2 + pre] === y[2 + pre]) pre++
  let suf = 0; while (suf < 40 && x[41 - suf] === y[41 - suf]) suf++
  if (pre >= 3 && suf >= 3) return { level: 'high', pre, suf }
  if (pre >= 5 || suf >= 5 || (pre + suf >= 6)) return { level: 'medium', pre, suf }
  return null
}

export function extractAddresses (text) {
  // whole addresses only: not the tail of a longer hex string or word on the left, not followed by more hex
  return [...new Set(String(text || '').match(/(?<![0-9A-Za-z_])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) || [])].slice(0, 10)
}
