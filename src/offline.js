// Report (not assume) whether this process can reach the internet. Printed at the top of every
// offline command, and shown live in the UI's status pill, so the demo shows the network state the AI
// actually ran under.
import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'

const tcp = (host, port, timeout = 1500) => new Promise((resolve) => {
  const t0 = Date.now()
  const s = connect({ host, port, timeout })
  s.on('connect', () => { s.destroy(); resolve({ ok: true, ms: Date.now() - t0 }) })
  s.on('timeout', () => { s.destroy(); resolve({ ok: false, error: 'TIMEOUT', ms: Date.now() - t0 }) })
  s.on('error', (e) => resolve({ ok: false, error: String(e.code || e.name).slice(0, 24), ms: Date.now() - t0 }))
})

const dnsCheck = (host) => lookup(host).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e.code || e.name).slice(0, 24) }))

export async function networkState () {
  const [ip, dns] = await Promise.all([tcp('1.1.1.1', 443), dnsCheck('huggingface.co')])
  return { online: ip.ok || dns.ok, tcp_1_1_1_1: ip.ok, dns: dns.ok, sandbox: process.env.SAUTI_SANDBOX || 'none' }
}

/**
 * Detailed proof for the UI: which interfaces exist, and what a TCP connect / DNS lookup actually returned.
 * Public-only data (interface names, error codes); no addresses of the host are included.
 */
export async function networkProof () {
  const [ip, ip6, dns] = await Promise.all([
    tcp('1.1.1.1', 443),
    tcp('2606:4700:4700::1111', 443),
    dnsCheck('huggingface.co')
  ])
  const ifaces = Object.keys(networkInterfaces()).sort().slice(0, 16)
  return {
    online: ip.ok || ip6.ok || dns.ok,
    sandbox: process.env.SAUTI_SANDBOX || 'none',
    interfaces: ifaces,
    tcp_ipv4: { target: '1.1.1.1:443', ...ip },
    tcp_ipv6: { target: '[2606:4700:4700::1111]:443', ...ip6 },
    dns: { target: 'huggingface.co', ...dns },
    at: new Date().toISOString()
  }
}
