#!/usr/bin/env node
// Check the offline signatures in the outbox WITHOUT any key and without any network: recover the signer from each
// queued raw transaction (ethers) and compare it with the wallet's public address and with the outbox record
// (token, recipient, amount, nonce, chain id, hash). Reads queue/<network>/ only; never reads private/.
//   node scripts/verify_outbox.mjs [--network devnet|sepolia] [--expect N]      (SAUTI_DATA=tmp/<name> for a test run)
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, getAddress } from 'ethers'
import { describeRaw } from '../src/txdecode.js'
import { network, NETWORKS } from '../src/networks.js'
import { Store } from '../src/queue.js'
import { fromUnits } from '../src/amount.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const netId = opt('--network') || JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).network
const expect = opt('--expect') === undefined ? null : Number(opt('--expect'))
if (!Object.hasOwn(NETWORKS, netId) || (expect !== null && !(Number.isInteger(expect) && expect >= 0 && expect < 1000))) {
  console.error('usage: node scripts/verify_outbox.mjs [--network devnet|sepolia] [--expect N]'); process.exit(2)
}
let data = ROOT
if (process.env.SAUTI_DATA) {
  data = resolve(ROOT, process.env.SAUTI_DATA)
  if (!data.startsWith(join(ROOT, 'tmp') + sep)) { console.error('SAUTI_DATA must be inside tmp/'); process.exit(2) }
}
const net = network(netId)
if (!existsSync(join(data, 'queue', netId))) { console.error(`no outbox for ${netId} yet`); process.exit(1) }
const store = new Store(join(data, 'queue'), netId)
const wallet = store.state().address ? getAddress(store.state().address) : null
const queued = store.list().filter((e) => e.status === 'queued')
let bad = 0
for (const e of queued) {
  const problems = []
  let d = null
  try { d = describeRaw(e.raw) } catch (x) { problems.push(`not a signed transaction (${String(x.message).slice(0, 60)})`) }
  if (d) {
    if (keccak256(e.raw) !== e.hash || d.hash !== e.hash) problems.push('hash')
    if (!wallet || getAddress(d.from) !== wallet) problems.push(`signer ${d.from} is not this wallet ${wallet}`)
    if (getAddress(d.from) !== getAddress(e.from)) problems.push('signer differs from the record')
    if (d.chainId !== net.chainId) problems.push(`chain ${d.chainId}`)
    if (getAddress(d.to) !== getAddress(e.token)) problems.push('token contract')
    if (!d.transfer || getAddress(d.transfer.to) !== getAddress(e.to)) problems.push('recipient')
    if (!d.transfer || d.transfer.amountUnits !== String(e.amountUnits)) problems.push('amount')
    if (d.nonce !== e.nonce) problems.push('nonce')
  }
  if (problems.length) bad++
  const what = d?.transfer ? `${fromUnits(BigInt(d.transfer.amountUnits))} test USDT -> ${e.recipientName || ''} ${d.transfer.to}` : '?'
  console.log(`${problems.length ? 'BAD ' : 'ok  '} nonce ${e.nonce}  ${what}  signed by ${d?.from || '?'} (chain ${d?.chainId ?? '?'})${problems.length ? `  PROBLEMS: ${problems.join(', ')}` : ''}`)
}
console.log(`${queued.length} queued signature(s) checked for ${net.name}, ${bad} bad; wallet ${wallet || 'unknown'}`)
if (bad || (expect !== null && queued.length !== expect)) process.exit(1)
