// Verify npm registry ECDSA signatures for every package in package-lock.json, plus whether
// the installed tarball integrity matches what the registry publishes.
// Written because the distro npm 9.2 `npm audit signatures` rejects any signature made with the
// registry key that expired 2025-01-29, even for versions published before that date.
// A signature counts as valid when it verifies AND the version was published before the key expired.
//   node scripts/verify_sigs.mjs          (reads ./package-lock.json; network: registry.npmjs.org only)
import { readFileSync, writeFileSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'

const REG = 'https://registry.npmjs.org'
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const keys = (await (await fetch(`${REG}/-/npm/v1/keys`)).json()).keys
const keyById = new Map(keys.map((k) => [k.keyid, k]))

const pkgs = Object.entries(lock.packages)
  .filter(([p, v]) => p && v.resolved && v.integrity)
  .map(([p, v]) => ({ name: p.split('node_modules/').pop(), version: v.version, integrity: v.integrity }))

const res = { total: pkgs.length, verified: 0, provenance: 0, bad: [], unsigned: [] }
const queue = [...pkgs]
async function worker () {
  while (queue.length) {
    const p = queue.shift()
    const r = await fetch(`${REG}/${p.name.replace('/', '%2f')}/${p.version}`)
    if (!r.ok) { res.bad.push(`${p.name}@${p.version}: HTTP ${r.status}`); continue }
    const meta = await r.json()
    if (meta.dist.integrity !== p.integrity) { res.bad.push(`${p.name}@${p.version}: integrity differs from registry`); continue }
    if (meta.dist.attestations?.provenance) res.provenance++
    const sigs = meta.dist.signatures || []
    if (!sigs.length) { res.unsigned.push(`${p.name}@${p.version}`); continue }
    let ok = false
    for (const s of sigs) {
      const k = keyById.get(s.keyid)
      if (!k) continue
      if (k.expires) {
        const full = await (await fetch(`${REG}/${p.name.replace('/', '%2f')}`, { headers: { accept: 'application/json' } })).json()
        if (new Date(full.time?.[p.version] || Date.now()) > new Date(k.expires)) continue
      }
      const pub = createPublicKey({ key: Buffer.from(k.key, 'base64'), format: 'der', type: 'spki' })
      if (verify('sha256', Buffer.from(`${p.name}@${p.version}:${p.integrity}`), pub, Buffer.from(s.sig, 'base64'))) ok = true
    }
    if (ok) res.verified++
    else res.bad.push(`${p.name}@${p.version}: no valid signature`)
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
writeFileSync('vetting/signatures.json', JSON.stringify(res, null, 1))
console.log(`packages=${res.total} signature_verified=${res.verified} with_provenance=${res.provenance} bad=${res.bad.length} unsigned=${res.unsigned.length}`)
for (const b of res.bad) console.log('BAD', b)
