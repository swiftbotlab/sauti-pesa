#!/usr/bin/env node
// Sauti Pesa NETWORK side. Everything that needs a connection lives here and nowhere else:
//   sync          refresh nonce, fee data, USDT + gas balances into the local cache (queue/<net>/state.json)
//   broadcast     send queued, already-signed transactions in nonce order; then wait for receipts (src/broadcast.js)
//   status        show the cache and the outbox
//   devnet-setup  (devnet only) deploy the test USDT contract and fund the test wallet on the local chain
//   devnet-bump-nonce (devnet only, tests) use up one nonce, as a payment from another device would
// It never reads private/ (the seed; it is not even visible here): signing already happened offline. Run it with
//   ops/sandbox.sh online node bin/netsync.mjs <cmd> --network sepolia     (public testnet)
//   ops/devnet.sh <cmd>                                                      (local chain in its own netns)
// Both hold an exclusive lock on queue/<net>/ for the whole run, so two runs never work on one outbox at once.
// This launcher checks that BEFORE loading any third-party package (ethers).
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

if (!['online', 'devnet'].includes(process.env.SAUTI_SANDBOX) || process.env.SAUTI_QUEUE_LOCKED !== '1') {
  console.error('refusing to run: start it with ops/sandbox.sh online node bin/netsync.mjs ... or ops/devnet.sh ...')
  process.exit(2)
}
const { Rpc } = await import('../src/net/rpc.js')
const { Store } = await import('../src/queue.js')
const { network } = await import('../src/networks.js')
const { broadcastQueue } = await import('../src/broadcast.js')
const { fromUnits } = await import('../src/amount.js')
const { getAddress, Interface, Transaction } = await import('ethers')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const cmd = argv[0]
const netId = argv.includes('--network') ? argv[argv.indexOf('--network') + 1] : 'devnet'
const net = network(netId)
const DATA = process.env.SAUTI_DATA ? resolve(ROOT, process.env.SAUTI_DATA) : ROOT
if (DATA !== ROOT && !DATA.startsWith(join(ROOT, 'tmp') + '/')) throw new Error('SAUTI_DATA must be inside tmp/')
const store = new Store(join(DATA, 'queue'), netId)
const rpc = new Rpc(net.rpc)
const ANVIL_DEV0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // anvil's public, pre-funded dev account (not a secret)

function addressOrDie () {
  const a = store.state().address
  if (!a) throw new Error('wallet address unknown: run "node bin/sauti.mjs wallet address" (offline) first')
  return a
}

async function waitReceipt (hash, ms = 90000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const r = await rpc.receipt(hash)
    if (r) return r
    await new Promise((resolve) => setTimeout(resolve, netId === 'devnet' ? 300 : 4000))
  }
  return null
}

async function sync () {
  const chainId = await rpc.chainId()
  if (chainId !== net.chainId) throw new Error(`RPC is on chain ${chainId}, expected ${net.chainId}`)
  const address = addressOrDie()
  const token = net.token.address || store.state().tokenAddress
  const [nonce, fees, native] = await Promise.all([rpc.nonce(address), rpc.fees(), rpc.nativeBalance(address)])
  const balance = token ? await rpc.tokenBalance(token, address) : null
  // Gas limit for offline signatures: estimate the WORST case, a first transfer to an address that has never held
  // the token (a new storage slot; on the Sepolia test token that costs ~141k gas vs ~43k for an existing holder).
  // Estimating against a contact who already holds tokens gave a limit that new recipients run out of.
  let gasLimit = null
  if (token && balance > 0n) {
    const est = []
    try { est.push(await rpc.estimateTransferGas(address, token, '0x' + randomBytes(20).toString('hex'), 1n)) } catch {}
    try {
      const anyContact = JSON.parse(readFileSync(join(ROOT, 'data/demo-contacts.json'), 'utf8'))[0].address
      est.push(await rpc.estimateTransferGas(address, token, anyContact, 1n))
    } catch {}
    if (est.length) gasLimit = est.reduce((a, b) => (a > b ? a : b)) * 13n / 10n + 15000n
  }
  const at = new Date().toISOString()
  const s = store.saveState({
    chainId, address, nonce, nonceAt: at,
    fees: { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, baseFee: fees.baseFee, at },
    balance: balance === null ? null : { units: balance, at },
    native: { wei: native, at },
    ...(gasLimit ? { gasLimit } : {}),
    tokenAddress: token
  })
  console.log(`synced ${net.name}: nonce ${s.nonce}, test USDT ${balance === null ? '?' : fromUnits(balance)}, gas balance ${fromUnits(native, 18)} ${net.nativeSymbol}, maxFee ${fromUnits(fees.maxFeePerGas, 9)} gwei`)
}

async function broadcast () {
  await sync()
  const r = await broadcastQueue({ rpc, store, chainId: net.chainId, address: addressOrDie(), explorer: net.explorer, pollMs: netId === 'devnet' ? 300 : 4000 })
  if (r.unknown) console.log(`${r.unknown} payment(s) still waiting for a result; run broadcast again later`)
  if (r.held) console.log('a payment is still in its undo window (held on this device); run broadcast again after the time shown')
  await sync()
}

async function devnetSetup () {
  if (netId !== 'devnet') throw new Error('devnet-setup only runs on the local devnet')
  const address = addressOrDie()
  let token = net.token.address
  if (token && (await rpc.call('eth_getCode', [token, 'latest'])) !== '0x') { console.log(`devnet: test USDT already at ${token}`) } else {
    const art = JSON.parse(readFileSync(join(ROOT, 'data/MockUSDT.json'), 'utf8'))
    const h = await rpc.call('eth_sendTransaction', [{ from: ANVIL_DEV0, data: art.bytecode, gas: '0x200000' }])
    token = getAddress((await waitReceipt(h)).contractAddress)
    if (token !== net.token.address) throw new Error(`MockUSDT deployed at ${token}, expected ${net.token.address} (devnet state not fresh?)`)
    const mint = '0x40c10f19' + address.slice(2).toLowerCase().padStart(64, '0') + (1000n * 10n ** 6n).toString(16).padStart(64, '0')
    await waitReceipt(await rpc.call('eth_sendTransaction', [{ from: ANVIL_DEV0, to: token, data: mint, gas: '0x30000' }]))
    await rpc.call('anvil_setBalance', [address, '0xde0b6b3a7640000']) // 1 test ETH for gas
    store.saveState({ tokenAddress: token })
    console.log(`devnet: deployed test USDT at ${token}, minted 1000 test USDT + 1 test ETH to ${address}`)
  }
  await sync()
}

// Dev helper for Sepolia: broadcast the offline-signed faucet mint (scripts/sepolia_faucet_sign.mjs) after
// checking that it is exactly a test-USDT faucet mint to our own address.
async function faucetMint () {
  if (netId !== 'sepolia') throw new Error('faucet-mint is for sepolia')
  const raw = readFileSync(join(DATA, 'queue/sepolia/faucet-mint.raw'), 'utf8').trim()
  const t = Transaction.from(raw)
  const d = new Interface(['function mint(address token, address to, uint256 amount)']).decodeFunctionData('mint', t.data)
  if (getAddress(t.to) !== '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D' || getAddress(d[0]) !== net.token.address || getAddress(d[1]) !== addressOrDie() || t.from !== addressOrDie() || Number(t.chainId) !== net.chainId) throw new Error('raw tx is not the expected faucet mint')
  const hash = await rpc.sendRaw(raw)
  console.log(`faucet mint sent ${net.explorer}${hash}`)
  const r = await waitReceipt(hash, 180000)
  console.log(r ? `  ${r.status === '0x1' ? 'confirmed' : 'FAILED'} in block ${Number(BigInt(r.blockNumber))}` : '  no receipt yet')
  await sync()
}

// TEST HELPER, local devnet only: move the wallet's nonce forward on the throwaway chain, the way a payment
// made from another device would. Used to exercise the needs_resign -> resign path end to end.
async function devnetBumpNonce () {
  if (netId !== 'devnet') throw new Error('devnet-bump-nonce only runs on the local devnet')
  const address = addressOrDie()
  const n = await rpc.nonce(address)
  await rpc.call('anvil_setNonce', [address, '0x' + (n + 1).toString(16)])
  console.log(`devnet: nonce of ${address} moved ${n} -> ${await rpc.nonce(address)}`)
  await sync()
}

function status () {
  const s = store.state()
  console.log(JSON.stringify({ network: net.name, address: s.address, nonce: s.nonce, usdt: s.balance ? fromUnits(s.balance.units) : null, synced: s.nonceAt || null }))
  for (const e of store.list()) console.log(`${e.status.padEnd(12)} nonce ${e.nonce}  ${e.amount} test USDT -> ${e.recipientName || e.to}  ${e.hash}`)
}

const run = { sync, broadcast, status, 'devnet-setup': devnetSetup, 'devnet-bump-nonce': devnetBumpNonce, 'faucet-mint': faucetMint }[cmd]
if (!run) { console.log('usage: netsync.mjs sync|broadcast|status|devnet-setup [--network devnet|sepolia]'); process.exit(2) }
Promise.resolve(run()).catch((e) => { console.error(`error: ${e.message}`); process.exit(1) })
