// Broadcast decisions (src/broadcast.js) against a scripted RPC: no network, no chain. The signed transactions are
// real (ethers, a throwaway key made in memory for this test and never stored).
// The bug these tests pin down: a payment that was waiting in the mempool counted as "nonce used by another
// transaction", so the person was offered a re-signature, and both transactions could be mined (double payment).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Wallet, Interface, Transaction } from 'ethers'
import { Store } from '../src/queue.js'
import { broadcastQueue } from '../src/broadcast.js'

const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const TO = '0x23A5e0dC05105FEE4Be4900e26Ec5f10Eb5656Cc'
const CHAIN = 31337
const key = Wallet.createRandom()

async function signed (nonce, amountUnits = 15_000_000n) {
  const raw = await key.signTransaction({ type: 2, chainId: CHAIN, nonce, to: TOKEN, data: ERC20.encodeFunctionData('transfer', [TO, amountUnits]), gasLimit: 90000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, value: 0n })
  return { raw, hash: Transaction.from(raw).hash, nonce, amountUnits: amountUnits.toString(), amount: '15', to: TO, token: TOKEN, network: 'devnet', signedOffline: true }
}

function fixture () {
  const dir = mkdtempSync(fileURLToPath(new URL('../tmp/btest-', import.meta.url)))
  return { store: new Store(dir, 'devnet'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

// A scripted node. latest = mined nonce, pending = latest + our transactions in its mempool.
function fakeRpc ({ latest = 0, pending = latest, receipts = {}, known = new Set(), send = null } = {}) {
  const calls = { sendRaw: [], txByHash: 0 }
  const rpc = {
    calls,
    receipt: async (h) => receipts[h] || null,
    confirmedNonce: async () => latest,
    nonce: async () => pending,
    txByHash: async (h) => { calls.txByHash++; return known.has(h) ? { hash: h } : null },
    sendRaw: async (raw) => { calls.sendRaw.push(raw); if (send) return send(raw); return Transaction.from(raw).hash }
  }
  return rpc
}
const run = (rpc, store, extra = {}) => broadcastQueue({ rpc, store, chainId: CHAIN, address: key.address, log: () => {}, receiptWaitMs: 30, pollMs: 5, ...extra })
const rcpt = (n = 7) => ({ status: '0x1', blockNumber: `0x${n.toString(16)}`, gasUsed: '0xb000' })
const transportError = () => Object.assign(new Error('all RPC endpoints failed for eth_sendRawTransaction: ECONNRESET'), { transport: true })
const nodeError = (m) => Object.assign(new Error(`eth_sendRawTransaction: ${m}`), { rpc: true })

test('a payment waiting in the mempool is NOT offered for re-signing (no double payment)', async () => {
  const { store, done } = fixture()
  try {
    const t = await signed(5)
    const e = store.add(t) // still "queued": an earlier run sent it, then stopped before saving the result
    // mined nonce 5, pending 6 (our tx in the mempool), no receipt yet. The OLD rule (pending nonce past it and no
    // receipt) would have said "needs re-sign" here.
    const rpc = fakeRpc({ latest: 5, pending: 6, known: new Set([t.hash]) })
    await run(rpc, store)
    const after = store.list().find((x) => x.id === e.id)
    assert.equal(after.status, 'broadcast')
    assert.equal(rpc.calls.sendRaw.length, 0)
  } finally { done() }
})

test('needs_resign only when the mined nonce is past it, the node does not know it and there is no receipt', async () => {
  const { store, done } = fixture()
  try {
    const t = await signed(5)
    const e = store.add(t)
    await run(fakeRpc({ latest: 6, pending: 6 }), store) // nonce 5 mined by some other transaction
    assert.equal(store.list().find((x) => x.id === e.id).status, 'needs_resign')
    // control: same chain state, but the node knows our hash (mined a moment ago, receipt not indexed yet)
    store.update(e.id, { status: 'queued' })
    await run(fakeRpc({ latest: 6, pending: 6, known: new Set([t.hash]) }), store)
    assert.equal(store.list().find((x) => x.id === e.id).status, 'broadcast')
    // control: a receipt exists -> confirmed
    await run(fakeRpc({ latest: 6, pending: 6, receipts: { [t.hash]: rcpt() } }), store)
    const c = store.list().find((x) => x.id === e.id)
    assert.equal(c.status, 'confirmed')
    assert.equal(c.block, 7)
  } finally { done() }
})

test('a network error while sending keeps the payment (unknown, still in the daily limit) and re-checks it by hash', async () => {
  const { store, done } = fixture()
  try {
    const t = await signed(5)
    const e = store.add(t)
    const rpc1 = fakeRpc({ latest: 5, pending: 5, send: () => { throw transportError() } })
    const r1 = await run(rpc1, store)
    const a = store.list().find((x) => x.id === e.id)
    assert.equal(a.status, 'queued') // never "failed"
    assert.match(a.error, /result unknown/)
    assert.equal(r1.unknown, 1)
    assert.ok(store.history().some((h) => h.amountUnits === t.amountUnits), 'still counts in the daily limit')
    // next run: the node did receive it (in the mempool). It is not sent twice and not offered for re-signing.
    const rpc2 = fakeRpc({ latest: 5, pending: 6, known: new Set([t.hash]) })
    await run(rpc2, store)
    assert.equal(rpc2.calls.sendRaw.length, 0)
    assert.equal(store.list().find((x) => x.id === e.id).status, 'broadcast')
    // and once mined: confirmed
    await run(fakeRpc({ latest: 6, pending: 6, receipts: { [t.hash]: rcpt(9) } }), store)
    assert.equal(store.list().find((x) => x.id === e.id).status, 'confirmed')
  } finally { done() }
})

test('a transport error while checking a payment aborts the run and changes nothing', async () => {
  const { store, done } = fixture()
  try {
    const e = store.add(await signed(5))
    const rpc = fakeRpc({ latest: 6, pending: 6 })
    rpc.receipt = async () => { throw transportError() }
    await assert.rejects(run(rpc, store), /all RPC endpoints failed/)
    assert.equal(store.list().find((x) => x.id === e.id).status, 'queued')
  } finally { done() }
})

test('node answers: "already known" counts as sent; a refusal keeps it queued and stops (nonce order)', async () => {
  const { store, done } = fixture()
  try {
    const t5 = await signed(5)
    const e5 = store.add(t5)
    await run(fakeRpc({ latest: 5, pending: 5, send: () => { throw nodeError('already known') } }), store)
    assert.equal(store.list().find((x) => x.id === e5.id).status, 'broadcast')
    const t6 = await signed(6); const t7 = await signed(7)
    const e6 = store.add(t6); const e7 = store.add(t7)
    store.update(e5.id, { status: 'confirmed' })
    const rpc = fakeRpc({ latest: 6, pending: 6, send: () => { throw nodeError('insufficient funds for gas * price + value') } })
    await run(rpc, store)
    const a6 = store.list().find((x) => x.id === e6.id)
    assert.equal(a6.status, 'queued')
    assert.match(a6.error, /node refused/)
    assert.equal(rpc.calls.sendRaw.length, 1, 'nonce 7 is not sent while nonce 6 is stuck')
    assert.equal(store.list().find((x) => x.id === e7.id).status, 'queued')
  } finally { done() }
})

test('a broadcast payment that fell out of the mempool is sent again with the SAME signed bytes', async () => {
  const { store, done } = fixture()
  try {
    const t = await signed(5)
    const e = store.add(t)
    store.update(e.id, { status: 'broadcast' })
    const rpc = fakeRpc({ latest: 5, pending: 5 }) // nonce still free, node does not know the hash
    await run(rpc, store)
    assert.deepEqual(rpc.calls.sendRaw, [t.raw])
    assert.equal(store.list().find((x) => x.id === e.id).status, 'broadcast')
  } finally { done() }
})

test('another pending transaction holding our nonce: wait, do not re-sign yet', async () => {
  const { store, done } = fixture()
  try {
    const e = store.add(await signed(5))
    const rpc = fakeRpc({ latest: 5, pending: 6 }) // nonce 5 pending, but not our hash
    await run(rpc, store)
    const a = store.list().find((x) => x.id === e.id)
    assert.equal(a.status, 'queued')
    assert.equal(rpc.calls.sendRaw.length, 0)
  } finally { done() }
})

test('a record that does not match its signed bytes is never sent', async () => {
  const { store, done } = fixture()
  try {
    const t = await signed(5)
    const e = store.add({ ...t, to: '0x1111111111111111111111111111111111111111' })
    const rpc = fakeRpc({ latest: 5, pending: 5 })
    await run(rpc, store)
    assert.equal(store.list().find((x) => x.id === e.id).status, 'failed')
    assert.equal(rpc.calls.sendRaw.length, 0)
  } finally { done() }
})
