// Undo window (src/undo.js): cancel a queued payment that was never sent, hold flagged payments for a few minutes,
// and keep nonces right (no gap, no replay). Real signed transactions (ethers, a throwaway key made in memory for
// this test and never stored), a real outbox in tmp/, a scripted RPC for the broadcaster.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Wallet, Interface, Transaction } from 'ethers'
import { Store } from '../src/queue.js'
import { broadcastQueue } from '../src/broadcast.js'
import { confirmAndQueue, resignEntry } from '../src/pipeline.js'
import { cancelEntry, canCancel, holdFor, holdMinutesFrom, isHeld, HOLD_CODES } from '../src/undo.js'
import { outboxView } from '../src/view.js'

const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const TO = '0x23A5e0dC05105FEE4Be4900e26Ec5f10Eb5656Cc'
const CHAIN = 31337
const key = Wallet.createRandom()
const T0 = Date.parse('2026-10-28T14:03:00Z')

async function signRaw ({ nonce, to = TO, amountUnits = 15_000_000n, token = TOKEN }) {
  const raw = await key.signTransaction({ type: 2, chainId: CHAIN, nonce, to: token, data: ERC20.encodeFunctionData('transfer', [to, amountUnits]), gasLimit: 90000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, value: 0n })
  return { raw, hash: Transaction.from(raw).hash }
}
async function entry (nonce, extra = {}) {
  const amountUnits = extra.amountUnits ?? 15_000_000n
  const s = await signRaw({ nonce, amountUnits })
  return { ...s, nonce, amountUnits: amountUnits.toString(), amount: String(Number(amountUnits) / 1e6), to: TO, token: TOKEN, network: 'devnet', signedOffline: true, recipientName: 'Juma', ...extra, ...(extra.amountUnits ? { amountUnits: extra.amountUnits.toString() } : {}) }
}
// the offline signer as src/wallet.js exposes it (approve, then sign exactly that transfer)
const wallet = {
  approved: null,
  approve (t) { this.approved = t },
  async signTransfer ({ token, to, amountUnits, nonce }) {
    assert.deepEqual({ token, to, amountUnits }, this.approved, 'signs only what was approved')
    return signRaw({ nonce, to, amountUnits, token })
  },
  async address () { return key.address }
}
function fixture () {
  const dir = mkdtempSync(fileURLToPath(new URL('../tmp/utest-', import.meta.url)))
  const store = new Store(dir, 'devnet')
  store.saveState({ nonce: 0, address: key.address })
  return { store, dir: join(dir, 'devnet'), done: () => rmSync(dir, { recursive: true, force: true }) }
}
function fakeRpc ({ latest = 0, onReceipt = null } = {}) {
  let pending = latest
  const calls = { sendRaw: [] }
  return {
    calls,
    receipt: async (h) => { if (onReceipt) await onReceipt(h); return null },
    confirmedNonce: async () => latest,
    nonce: async () => pending,
    txByHash: async () => null,
    sendRaw: async (raw) => { calls.sendRaw.push(raw); pending++; return Transaction.from(raw).hash }
  }
}
const run = (rpc, store, clock = () => T0) => broadcastQueue({ rpc, store, chainId: CHAIN, address: key.address, log: process.env.UNDO_LOG ? console.log : () => {}, receiptWaitMs: 5, pollMs: 1, clock })
const analysis = (codes) => ({
  ok: true,
  decision: codes.length ? 'confirm_with_warnings' : 'confirm',
  reasons: codes.map((code) => ({ code, severity: 'warn' })),
  recipient: { address: TO, name: 'Juma' },
  amountUnits: 15_000_000n,
  intent: { amount: '15', memo: null },
  needsRetype: false,
  lang: 'sw'
})

test('hold: only flagged payments wait; a re-typed amount alone does not; 0 minutes = off', () => {
  const h = holdFor(analysis(['new_recipient']), 10, T0)
  assert.equal(h.holdUntil, '2026-10-28T14:13:00.000Z')
  assert.deepEqual(h.holdReasons, ['new_recipient'])
  for (const c of HOLD_CODES) assert.ok(holdFor(analysis([c]), 10, T0), c)
  assert.equal(holdFor(analysis(['retype_amount']), 10, T0), null)
  assert.equal(holdFor(analysis(['token_assumed', 'self_send']), 10, T0), null)
  assert.equal(holdFor(analysis([]), 10, T0), null)
  assert.equal(holdFor(analysis(['new_recipient']), 0, T0), null)
  assert.equal(holdFor({ reasons: [{ code: 'new_recipient', severity: 'block' }] }, 10, T0), null, 'a blocked reason never reaches signing')
  assert.equal(holdFor(analysis(['scam_signals']), 600, T0).holdUntil, '2026-10-28T15:03:00.000Z', 'capped at 60 minutes')
  assert.equal(holdMinutesFrom({ hold_minutes: 0 }), 0)
  assert.equal(holdMinutesFrom({ hold_minutes: 25 }), 25)
  for (const bad of [-1, 61, 2.5, '10', null]) assert.equal(holdMinutesFrom({ hold_minutes: bad }), 10)
  assert.equal(holdMinutesFrom({}), 10)
})

test('confirm: a new-recipient payment is signed and queued with a hold; a clean one is not held', async () => {
  const { store, done } = fixture()
  try {
    const a = await confirmAndQueue({ analysis: analysis(['new_recipient']), wallet, store, networkId: 'devnet', tokenAddress: TOKEN, holdMinutes: 10, now: T0 })
    assert.equal(a.status, 'queued')
    assert.equal(a.holdUntil, '2026-10-28T14:13:00.000Z')
    assert.ok(isHeld(a, T0 + 9 * 60000) && !isHeld(a, T0 + 10 * 60000))
    const b = await confirmAndQueue({ analysis: analysis([]), wallet, store, networkId: 'devnet', tokenAddress: TOKEN, holdMinutes: 10, now: T0 })
    assert.equal(b.holdUntil, undefined)
    assert.equal(b.nonce, 1)
  } finally { done() }
})

test('cancel the newest queued payment: never sent, bytes deleted, its nonce is reused (no gap)', async () => {
  const { store, dir, done } = fixture()
  try {
    const a = store.add(await entry(0))
    const b = store.add(await entry(1))
    assert.equal(store.nextNonce(), 2)
    const r = cancelEntry({ store, id: b.id, chainId: CHAIN, now: T0 })
    assert.equal(r.entry.status, 'cancelled')
    assert.equal(r.entry.raw, null)
    assert.equal(r.entry.cancelledAt, '2026-10-28T14:03:00.000Z')
    assert.deepEqual(r.resign, [])
    assert.equal(store.claimOf(b.hash).by, 'cancel')
    assert.equal(store.nextNonce(), 1, 'the next payment reuses nonce 1')
    assert.equal(store.history().length, 1, 'a cancelled payment does not count toward the daily limit')
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('tx-') && JSON.stringify(store.get(f.slice(3, 39))).includes(b.raw)), 'signed bytes are gone from the outbox')
    // broadcast: only A goes out; B is never sent
    const rpc = fakeRpc()
    await run(rpc, store)
    assert.deepEqual(rpc.calls.sendRaw, [a.raw])
    assert.equal(store.get(b.id).status, 'cancelled')
    // a cancelled entry cannot be cancelled or re-signed again
    assert.throws(() => cancelEntry({ store, id: b.id, chainId: CHAIN }), /only a queued payment/)
    await assert.rejects(resignEntry({ entryId: b.id, wallet, store, networkId: 'devnet', chainId: CHAIN }), /only "needs_resign"/)
    // signatures are deterministic: a NEW payment with the same recipient, amount, nonce and fees has the same hash
    // as the cancelled one. It is a new signature (its own signId), so it is sent; the cancel does not block it.
    const again = store.add({ ...(await entry(1)), signId: '6f9619ff-8b86-4011-b42d-00c04fc964ff' })
    assert.equal(again.hash, b.hash)
    assert.equal(again.nonce, store.nextNonce() - 1)
    const rpc2 = fakeRpc({ latest: 1 })
    await run(rpc2, store)
    assert.deepEqual(rpc2.calls.sendRaw, [again.raw])
  } finally { done() }
})

test('cancel a payment with newer ones behind it: they come back for re-signing and move down one nonce', async () => {
  const { store, done } = fixture()
  try {
    const a = store.add(await entry(0))
    const b = store.add(await entry(1, { amountUnits: 20_000_000n }))
    const c = store.add(await entry(2, { amountUnits: 30_000_000n }))
    const r = cancelEntry({ store, id: a.id, chainId: CHAIN, now: T0 })
    assert.equal(r.entry.status, 'cancelled')
    assert.deepEqual(r.resign.map((x) => x.id), [b.id, c.id])
    for (const x of [b, c]) {
      const y = store.get(x.id)
      assert.equal(y.status, 'needs_resign')
      assert.equal(y.raw, null, 'old signed bytes deleted')
      assert.equal(y.resignReason, 'earlier_cancelled')
      assert.equal(store.claimOf(x.hash).by, 'cancel', 'old hash can never be sent by the broadcaster')
    }
    assert.equal(store.nextNonce(), 0, 'nonce 0 is free again')
    // nothing can be broadcast now: no queued entries
    const rpc0 = fakeRpc()
    await run(rpc0, store)
    assert.equal(rpc0.calls.sendRaw.length, 0)
    // re-sign C first, then B: they take nonces 0 and 1, no gap, no duplicate
    const c2 = await resignEntry({ entryId: c.id, wallet, store, networkId: 'devnet', chainId: CHAIN })
    const b2 = await resignEntry({ entryId: b.id, wallet, store, networkId: 'devnet', chainId: CHAIN })
    assert.equal(c2.nonce, 0)
    assert.equal(b2.nonce, 1)
    assert.equal(c2.amountUnits, '30000000')
    assert.notEqual(c2.hash, c.hash)
    assert.equal(c2.resignReason, null)
    assert.equal(store.nextNonce(), 2)
    const queued = store.list().filter((x) => x.status === 'queued')
    assert.deepEqual(queued.map((x) => x.nonce), [0, 1])
    // broadcast sends exactly the two new transactions, in nonce order; none of the withdrawn/cancelled bytes
    const rpc = fakeRpc()
    await run(rpc, store)
    assert.deepEqual(rpc.calls.sendRaw, [c2.raw, b2.raw])
    // the cancelled A and C's withdrawn nonce-2 bytes are never sent. B went back to its own nonce 1 with the same
    // fees, so its new signature is byte-identical to the withdrawn one (deterministic signatures): that is the same
    // single payment the person confirmed, sent once, and it is sendable because the claim belongs to a signature
    // (signId), not to a hash.
    for (const old of [a.raw, c.raw]) assert.ok(!rpc.calls.sendRaw.includes(old))
    assert.equal(b2.raw, b.raw)
    assert.equal(rpc.calls.sendRaw.filter((x) => x === b2.raw).length, 1)
  } finally { done() }
})

test('cancel is refused once a payment was handed to the network (or could have been)', async () => {
  const { store, done } = fixture()
  try {
    const sent = store.add(await entry(0, { status: 'broadcast', broadcastAt: new Date(T0).toISOString() }))
    assert.throws(() => cancelEntry({ store, id: sent.id, chainId: CHAIN }), /only a queued payment/)
    const tried = store.add(await entry(1, { sendTriedAt: new Date(T0).toISOString() })) // network error while sending
    assert.throws(() => cancelEntry({ store, id: tried.id, chainId: CHAIN }), /already handed to the network/)
    const refused = store.add(await entry(2, { error: 'node refused: insufficient funds for gas' }))
    assert.throws(() => cancelEntry({ store, id: refused.id, chainId: CHAIN }), /already handed to the network/)
    const claimed = store.add(await entry(3))
    assert.ok(store.claim(claimed.hash, 'send').ok) // the broadcaster decided first
    assert.equal(canCancel(store.get(claimed.id), store), false)
    assert.throws(() => cancelEntry({ store, id: claimed.id, chainId: CHAIN }), /already handed to the network/)
    assert.equal(store.get(claimed.id).status, 'queued', 'nothing changed')
    assert.equal(typeof store.get(claimed.id).raw, 'string')
    assert.throws(() => cancelEntry({ store, id: '00000000-0000-0000-0000-000000000000', chainId: CHAIN }), /no such outbox entry/)
    assert.throws(() => cancelEntry({ store, id: '../state', chainId: CHAIN }), /no such outbox entry/)
  } finally { done() }
})

test('cancel refuses a record that does not match its signed bytes (and changes nothing)', async () => {
  const { store, done } = fixture()
  try {
    const a = store.add(await entry(0))
    store.update(a.id, { amountUnits: '1000000' }) // tampered record
    assert.throws(() => cancelEntry({ store, id: a.id, chainId: CHAIN }), /does not match/)
    assert.equal(store.get(a.id).status, 'queued')
    assert.equal(store.claimOf(a.hash), null)
    // a newer entry with a tampered record also stops the cancel of an older one
    const { store: s2, done: d2 } = fixture()
    try {
      const x = s2.add(await entry(0))
      const y = s2.add(await entry(1))
      s2.update(y.id, { to: '0x1111111111111111111111111111111111111111' })
      assert.throws(() => cancelEntry({ store: s2, id: x.id, chainId: CHAIN }), /nonce 1 does not match/)
      assert.equal(s2.get(x.id).status, 'queued')
      assert.equal(s2.claimOf(x.hash), null)
    } finally { d2() }
    // a withdrawn entry is only re-signed when its old bytes are gone and the cancel record exists
    const b = store.add(await entry(1, { status: 'needs_resign', resignReason: 'earlier_cancelled' }))
    await assert.rejects(resignEntry({ entryId: b.id, wallet, store, networkId: 'devnet', chainId: CHAIN }), /still has signed bytes/)
    store.update(b.id, { raw: null })
    await assert.rejects(resignEntry({ entryId: b.id, wallet, store, networkId: 'devnet', chainId: CHAIN }), /no cancel record/)
  } finally { done() }
})

test('broadcaster: a held payment is not sent, nor anything after it, until the hold ends', async () => {
  const { store, done } = fixture()
  try {
    const held = store.add({ ...(await entry(0)), holdUntil: '2026-10-28T14:13:00.000Z', holdReasons: ['new_recipient'] })
    const next = store.add(await entry(1))
    const rpc = fakeRpc()
    const r1 = await run(rpc, store, () => T0 + 5 * 60000) // 14:08
    assert.equal(rpc.calls.sendRaw.length, 0)
    assert.equal(r1.held, 1)
    assert.equal(store.get(held.id).status, 'queued')
    assert.equal(store.claimOf(held.hash), null, 'still cancellable')
    assert.ok(outboxView(store.get(held.id), { explorer: null }, store, T0 + 5 * 60000).held)
    assert.ok(outboxView(store.get(held.id), { explorer: null }, store, T0 + 5 * 60000).cancellable)
    const r2 = await run(rpc, store, () => T0 + 10 * 60000) // 14:13: the hold is over
    assert.deepEqual(rpc.calls.sendRaw, [held.raw, next.raw])
    assert.equal(r2.sent, 2)
    assert.equal(store.claimOf(held.hash).by, 'send')
    const v = outboxView(store.get(held.id), { explorer: null }, store, T0 + 10 * 60000)
    assert.equal(v.cancellable, false, 'once sent it cannot be cancelled')
    assert.equal(v.held, false)
  } finally { done() }
})

test('broadcaster: a cancel that lands while it runs wins; the cancelled bytes are never sent', async () => {
  const { store, done } = fixture()
  try {
    const a = store.add(await entry(0))
    const b = store.add(await entry(1))
    // the broadcaster has listed the outbox; while it checks A's receipt, the person cancels A on the device
    const rpc = fakeRpc({ onReceipt: async (h) => { if (h === a.hash && store.get(a.id).status === 'queued') cancelEntry({ store, id: a.id, chainId: CHAIN }) } })
    const r = await run(rpc, store)
    assert.equal(rpc.calls.sendRaw.length, 0, 'neither A nor B was sent')
    assert.equal(r.cancelled, 1)
    assert.equal(store.get(a.id).status, 'cancelled')
    assert.equal(store.get(b.id).status, 'needs_resign')
    // and a cancel file planted for a hash makes the broadcaster skip it too
    const { store: s2, done: d2 } = fixture()
    try {
      const x = s2.add(await entry(0))
      s2.claim(x.hash, 'cancel')
      const rpc2 = fakeRpc()
      await run(rpc2, s2)
      assert.equal(rpc2.calls.sendRaw.length, 0)
    } finally { d2() }
  } finally { done() }
})

test('claims are exclusive and fail closed', async () => {
  const { store, dir, done } = fixture()
  try {
    const h = '0x' + 'ab'.repeat(32)
    assert.equal(store.claim(h, 'send').ok, true)
    const second = store.claim(h, 'cancel')
    assert.equal(second.ok, false)
    assert.equal(second.by, 'send', 'the first decision stands')
    const h2 = '0x' + 'cd'.repeat(32)
    writeFileSync(join(dir, `claim-${h2}.json`), 'not json')
    assert.equal(store.claimOf(h2).by, 'send', 'an unreadable claim counts as sent (never cancellable)')
    assert.throws(() => store.claim('0x123', 'send'), /bad claim key/)
    assert.throws(() => store.claim('../x', 'send'), /bad claim key/)
    assert.throws(() => store.claim(h, 'maybe'), /bad claim/)
    assert.equal(store.claimOf('../../x'), null)
  } finally { done() }
})
