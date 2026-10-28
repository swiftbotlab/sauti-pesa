// Broadcast the outbox: already-signed transactions, in nonce order. Used by bin/netsync.mjs (network side, no keys).
// Kept apart from the CLI so the decisions below can be tested with a scripted RPC (test/broadcast.test.js).
//
// The rule that matters: a payment is marked "needs_resign" (which lets the person sign it again with a new
// nonce) ONLY when the chain proves this exact transaction can no longer be mined:
//   - there is no receipt for its hash, AND
//   - the chain's LATEST (mined) nonce is already past its nonce, AND
//   - the node does not know the transaction at all (eth_getTransactionByHash is null).
// A transaction that is merely waiting in the mempool counts in the "pending" nonce but not in the latest one;
// treating that as "nonce used elsewhere" would let the person re-sign it, and then both payments could be mined.
// Network errors never turn a payment into "failed" (which would drop it from the daily limit): the result is
// unknown, so the entry keeps its status and the next run checks it again by hash.
//
// Undo window (src/undo.js): a queued payment that is still on hold is not sent, and neither is anything after it
// (nonce order). A cancelled payment is never sent: each entry is read again from disk right before it is handled,
// and the broadcaster takes the atomic "send" claim on its signature before the bytes go to a node; if the person's
// "cancel" claim is already there, the payment is skipped.
import { describeRaw } from './txdecode.js'
import { isHeld, claimKey } from './undo.js'

const KNOWN_TX = /already known|known transaction|already imported|already exists|ALREADY_EXISTS|tx already in mempool/i
const NONCE_LOW = /nonce too low|nonce has already been used|NONCE_EXPIRED|old nonce/i

/**
 * @param {object} p
 * @param {object} p.rpc  receipt(hash), confirmedNonce(addr), nonce(addr) [pending], txByHash(hash), sendRaw(raw)
 * @param {object} p.store the outbox (src/queue.js Store)
 * @param {number} p.chainId
 * @param {string} p.address the wallet's public address
 * @param {string|null} [p.explorer]
 * @param {(s:string)=>void} [p.log]
 * @param {number} [p.receiptWaitMs] how long to wait for a receipt after sending
 * @param {number} [p.pollMs]
 * @param {() => number} [p.clock] ms since epoch (tests)
 * @returns {Promise<{sent:number, confirmed:number, needsResign:number, unknown:number, held:number, cancelled:number}>}
 */
export async function broadcastQueue ({ rpc, store, chainId, address, explorer = null, log = console.log, receiptWaitMs = 90000, pollMs = 4000, clock = Date.now }) {
  const now = () => new Date(clock()).toISOString()
  const out = { sent: 0, confirmed: 0, needsResign: 0, unknown: 0, held: 0, cancelled: 0 }
  const mined = (e, r) => {
    const ok = r.status === '0x1'
    store.update(e.id, { status: ok ? 'confirmed' : 'failed', block: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)), error: ok ? null : 'reverted on chain', checkedAt: now() })
    if (ok) out.confirmed++
    log(`  ${ok ? 'confirmed' : 'FAILED (reverted)'} in block ${Number(BigInt(r.blockNumber))}, gas used ${Number(BigInt(r.gasUsed))} (${e.hash.slice(0, 12)}…)`)
  }
  async function waitReceipt (hash) {
    const end = Date.now() + receiptWaitMs
    while (Date.now() < end) {
      try { const r = await rpc.receipt(hash); if (r) return r } catch { /* network hiccup: keep polling until the deadline */ }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    return null
  }

  for (const listed of store.list().filter((x) => x.status === 'queued' || x.status === 'broadcast')) {
    // read it again: the person may have cancelled it (or a payment before it) since the list was read
    const e = store.get(listed.id)
    if (!e || !['queued', 'broadcast'].includes(e.status) || typeof e.raw !== 'string') {
      log(`skip ${listed.id}: no longer waiting to be sent (${e ? e.status : 'gone'})`); out.cancelled++; break
    }
    if (isHeld(e, clock())) {
      log(`held until ${e.holdUntil} (undo window: ${(e.holdReasons || []).join(', ') || 'flagged'}): not sent yet; payments after it wait for it`)
      out.held++; break
    }
    if (store.claimOf(claimKey(e))?.by === 'cancel') { log(`skip ${e.id}: cancelled on this device`); out.cancelled++; break }
    const d = describeRaw(e.raw)
    if (d.hash !== e.hash || d.chainId !== chainId || d.from !== address || d.transfer?.to !== e.to || d.transfer?.amountUnits !== e.amountUnits) {
      store.update(e.id, { status: 'failed', error: 'queued transaction does not match its record' }); log(`skip ${e.id}: record mismatch`); continue
    }
    // 1. Mined already? A receipt is the only proof (an earlier run may have stopped before it saved the result).
    const receipt = await rpc.receipt(e.hash)
    if (receipt) { mined(e, receipt); continue }
    // 2. Is the nonce used ON CHAIN (latest, not pending)? Then this transaction can only still be mined if the node
    //    knows it (mined a moment ago, or a lagging node). Otherwise another transaction took the nonce.
    const latest = await rpc.confirmedNonce(address)
    if (d.nonce < latest) {
      const known = await rpc.txByHash(e.hash)
      if (known) {
        store.update(e.id, { status: 'broadcast', checkedAt: now(), error: null })
        log(`known to the node, no receipt yet: ${e.hash} (checked again next run)`); out.unknown++; continue
      }
      store.update(e.id, { status: 'needs_resign', error: `nonce ${d.nonce} was used by another transaction (chain at ${latest})`, checkedAt: now() })
      log(`needs re-sign: ${e.hash} (nonce ${d.nonce} used by another transaction; re-sign offline)`); out.needsResign++; continue
    }
    // 3. Not mined, nonce still free on chain. Is it waiting in the mempool already?
    const pending = await rpc.nonce(address)
    if (d.nonce < pending) {
      const known = await rpc.txByHash(e.hash)
      if (known) {
        if (e.status !== 'broadcast') store.update(e.id, { status: 'broadcast', broadcastAt: e.broadcastAt || now(), error: null })
        log(`pending in the mempool: ${e.hash}`)
        const r = await waitReceipt(e.hash)
        if (r) mined(e, r); else { out.unknown++; log('  no receipt yet; run broadcast/status again later') }
        continue
      }
      // another pending transaction holds this nonce: it may still be mined or dropped. Do not re-sign yet.
      log(`waiting: nonce ${d.nonce} is held by another pending transaction`); out.unknown++; break
    }
    if (d.nonce > pending) { log(`waiting: nonce gap (tx ${d.nonce}, chain ${pending})`); break }
    // 4. Send (or send again: the same signed bytes, so at most one of them can ever be mined). First the atomic
    //    decision: from here on this payment can no longer be cancelled on the device.
    const c = store.claim(claimKey(e), 'send')
    if (!c.ok && c.by === 'cancel') { log(`skip ${e.id}: cancelled on this device a moment ago`); out.cancelled++; break }
    if (!e.sentToNodeAt) store.update(e.id, { sentToNodeAt: now() })
    try {
      await rpc.sendRaw(e.raw)
    } catch (err) {
      const msg = String(err.message).slice(0, 200)
      if (err.rpc && KNOWN_TX.test(msg)) {
        log(`already known to the node: ${e.hash}`)
      } else if (err.rpc && NONCE_LOW.test(msg)) {
        store.update(e.id, { error: `node says: ${msg}`, checkedAt: now() })
        log(`  nonce taken meanwhile; checked again by hash next run`); out.unknown++; break
      } else if (err.rpc) {
        // the node refused it (e.g. not enough gas money). It is still a valid signed payment: keep it queued
        // (and inside the daily limit) so it can be sent later.
        store.update(e.id, { error: `node refused: ${msg}`, checkedAt: now() })
        log(`  refused by the node: ${msg}`); break
      } else {
        // network error: the node may or may not have received it. Unknown, never "failed".
        store.update(e.id, { error: `network error while sending; result unknown, checked again by hash next run (${msg.slice(0, 120)})`, sendTriedAt: now() })
        log(`  network error while sending; will check by hash next run`); out.unknown++; break
      }
    }
    store.update(e.id, { status: 'broadcast', broadcastAt: e.broadcastAt || now(), error: null })
    out.sent++
    log(`broadcast ${e.hash}  ${e.amount} test USDT -> ${e.recipientName || e.to}${explorer ? `  ${explorer}${e.hash}` : ''}`)
    const r = await waitReceipt(e.hash)
    if (r) mined(e, r); else { out.unknown++; log('  no receipt yet; run broadcast/status again later') }
  }
  return out
}
