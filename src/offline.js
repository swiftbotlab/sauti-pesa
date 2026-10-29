// Report (not assume) whether this process can reach the internet. Printed at the top of every
// offline command, and shown live in the UI's status pill, so the demo shows the network state the AI
// actually ran under.
//
// A leg counts as "no network" only when it failed with one of the error codes below, which mean that nothing on
// any network answered: no route, no interface, no usable address, no reachable DNS server, or no answer at all
// within the timeout. Every other outcome counts as ONLINE, including a refused or reset TCP connection (something
// on the network answered) and any error code not in these lists. The gate (src/gate.js) fails closed on that.
import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'

// TIMEOUT is the remaining gap: a network that silently drops these exact targets reads as "off" (SECURITY.md).
export const OFFLINE_TCP_ERRORS = Object.freeze(['ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'TIMEOUT'])
// an IPv6 leg on a computer without an IPv6 stack cannot reach anything either
export const OFFLINE_TCP6_ERRORS = Object.freeze([...OFFLINE_TCP_ERRORS, 'EAFNOSUPPORT'])
// EAI_AGAIN: no DNS server could be reached (Linux). ENOTFOUND: how macOS and Windows report a lookup with no
// network at all (getaddrinfo EAI_NONAME); a resolver that answers "no such name" for BOTH probe names reads the same.
export const OFFLINE_DNS_ERRORS = Object.freeze(['EAI_AGAIN', 'ENOTFOUND'])
export const TARGETS = Object.freeze({
  tcp_ipv4: { host: '1.1.1.1', port: 443, label: '1.1.1.1:443' },
  tcp_ipv6: { host: '2606:4700:4700::1111', port: 443, label: '[2606:4700:4700::1111]:443' },
  dns: 'huggingface.co',
  dns2: 'example.com'
})
const OFFLINE = { tcp_ipv4: OFFLINE_TCP_ERRORS, tcp_ipv6: OFFLINE_TCP6_ERRORS, dns: OFFLINE_DNS_ERRORS, dns2: OFFLINE_DNS_ERRORS }
export const PROBE_LEGS = Object.freeze(Object.keys(OFFLINE))

/** true only for a leg that failed with a "no network" code for its kind; anything else (or no answer) is false */
export function legOffline (name, leg) {
  if (!Object.hasOwn(OFFLINE, name) || !leg || typeof leg !== 'object') return false
  return leg.ok === false && typeof leg.error === 'string' && OFFLINE[name].includes(leg.error)
}

const tcp = (host, port, timeout = 1500) => new Promise((resolve) => {
  const t0 = Date.now()
  let s
  try { s = connect({ host, port, timeout }) } catch (e) { resolve({ ok: false, error: String(e.code || e.name).slice(0, 24), ms: 0 }); return }
  s.on('connect', () => { s.destroy(); resolve({ ok: true, ms: Date.now() - t0 }) })
  s.on('timeout', () => { s.destroy(); resolve({ ok: false, error: 'TIMEOUT', ms: Date.now() - t0 }) })
  s.on('error', (e) => resolve({ ok: false, error: String(e.code || e.name).slice(0, 24), ms: Date.now() - t0 }))
})

const dnsCheck = (host) => lookup(host).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e.code || e.name).slice(0, 24) }))

/** The short form for the CLI header (src/cli.mjs): the same legs and the same rule as networkProof(). */
export async function networkState () {
  const p = await networkProof()
  return { online: p.online, tcp_1_1_1_1: p.tcp_ipv4.ok, dns: p.dns.ok || p.dns2.ok, sandbox: p.sandbox }
}

/**
 * Detailed proof for the UI: which interfaces exist, and what a TCP connect / DNS lookup actually returned.
 * Public-only data (interface names, error codes); no addresses of the host are included.
 * Each leg carries offline: true only when its failure means "no network" (see the lists above).
 */
export async function networkProof () {
  const [ip, ip6, dns, dns2] = await Promise.all([
    tcp(TARGETS.tcp_ipv4.host, TARGETS.tcp_ipv4.port),
    tcp(TARGETS.tcp_ipv6.host, TARGETS.tcp_ipv6.port),
    dnsCheck(TARGETS.dns),
    dnsCheck(TARGETS.dns2)
  ])
  const ifaces = Object.keys(networkInterfaces()).sort().slice(0, 16)
  const legs = {
    tcp_ipv4: { target: TARGETS.tcp_ipv4.label, ...ip },
    tcp_ipv6: { target: TARGETS.tcp_ipv6.label, ...ip6 },
    dns: { target: TARGETS.dns, ...dns },
    dns2: { target: TARGETS.dns2, ...dns2 }
  }
  for (const [k, v] of Object.entries(legs)) v.offline = legOffline(k, v)
  return {
    online: !Object.values(legs).every((v) => v.offline),
    sandbox: process.env.SAUTI_SANDBOX || 'none',
    interfaces: ifaces,
    ...legs,
    at: new Date().toISOString()
  }
}
