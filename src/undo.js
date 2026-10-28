// Undo window. Payments are signed offline and wait in the outbox, so nothing has left the device until the
// broadcaster runs. That makes two things possible that an online wallet cannot do:
//   1. cancel a payment that is still queued and was never handed to a node;
//   2. hold a payment the checks flagged (a first-time recipient, scam wording, a look-alike or a relation that does
//      not match) for a few minutes before the broadcaster may send it: time to change your mind.
// Plain code, no network, no model. The broadcaster (src/broadcast.js) skips held and cancelled entries.
//
// Nonces. A cancelled entry gives its nonce back: store.nextNonce() ignores cancelled entries, so the next payment
// reuses it and there is no gap. Newer entries that were queued after it (they can never have been sent: the
// broadcaster sends in nonce order and stops at the first entry it cannot send) would wait forever behind the gap,
// so they become "needs_resign" with their signed bytes deleted and a "cancel" claim on their old signature. Signing
// one again gives it the lowest free nonce (src/pipeline.js resignEntry). Their old bytes were never sent and no
// longer exist, so no transaction can be mined twice.
import { describeRaw } from './txdecode.js'

/** The claim key of an entry's current signature (src/queue.js Store.claim). */
export const claimKey = (e) => e.signId || e.hash

// warning codes that put a payment on hold (src/safety.js); a re-typed large amount alone does not
export const HOLD_CODES = ['new_recipient', 'scam_signals', 'lookalike_address', 'relation_conflict']
export const DEFAULT_HOLD_MINUTES = 10
export const MAX_HOLD_MINUTES = 60

/** Hold minutes from config: an integer 0..60 (0 = no hold), anything else = the default. */
export function holdMinutesFrom (cfg) {
  const m = cfg?.hold_minutes
  return Number.isInteger(m) && m >= 0 && m <= MAX_HOLD_MINUTES ? m : DEFAULT_HOLD_MINUTES
}

/**
 * Should this confirmed payment wait in the outbox before it may be sent?
 * @returns {{ holdUntil: string, holdReasons: string[] } | null}
 */
export function holdFor (analysis, minutes, now = Date.now()) {
  if (!Number.isInteger(minutes) || minutes <= 0) return null
  const codes = [...new Set((analysis?.reasons || []).filter((r) => r.severity === 'warn' && HOLD_CODES.includes(r.code)).map((r) => r.code))]
  if (!codes.length) return null
  return { holdUntil: new Date(now + Math.min(minutes, MAX_HOLD_MINUTES) * 60000).toISOString(), holdReasons: codes }
}

/** Still inside its hold window (and never sent)? */
export function isHeld (e, now = Date.now()) {
  return e?.status === 'queued' && typeof e.holdUntil === 'string' && Date.parse(e.holdUntil) > now
}

/** Was this entry ever handed to a node (or could it have been)? Then it can no longer be undone offline. */
function handedToNetwork (e, store) {
  if (e.broadcastAt || e.sendTriedAt || e.sentToNodeAt) return true
  if (/^node (refused|says)/.test(String(e.error || ''))) return true
  const c = store.claimOf(claimKey(e))
  return !!c && c.by === 'send'
}

// the outbox record must describe exactly the transaction that was signed (checked before its bytes are deleted)
function recordMatches (e, chainId) {
  let d
  try { d = describeRaw(e.raw) } catch { return false }
  return d.hash === e.hash && d.chainId === chainId && !!d.transfer && d.transfer.to === e.to &&
    d.transfer.amountUnits === e.amountUnits && d.nonce === e.nonce && (d.to || '').toLowerCase() === String(e.token).toLowerCase()
}

/** Can the person cancel this entry now? */
export function canCancel (e, store) {
  return e?.status === 'queued' && typeof e.raw === 'string' && !handedToNetwork(e, store)
}

/**
 * Cancel a queued payment that was never sent. Newer queued payments get "needs_resign" (see above).
 * @returns {{ entry: object, resign: object[] }} the cancelled entry and the entries that must be signed again
 */
export function cancelEntry ({ store, id, chainId, now = Date.now() }) {
  const e = store.get(id)
  if (!e) throw new Error('no such outbox entry')
  if (e.status !== 'queued') throw new Error(`entry is "${e.status}": only a queued payment that was never sent can be cancelled`)
  if (handedToNetwork(e, store)) throw new Error('this payment was already handed to the network; it can no longer be cancelled offline')
  // the records must be the transactions that were signed (their bytes are deleted below, so check them now)
  if (!recordMatches(e, chainId)) throw new Error('outbox record does not match its signed transaction; refusing to change it')
  const newer = store.list().filter((x) => x.id !== e.id && x.status === 'queued' && x.nonce > e.nonce)
  for (const x of newer) {
    if (handedToNetwork(x, store)) throw new Error(`a newer payment (nonce ${x.nonce}) was already handed to the network; cancel is not safe now`)
    if (!recordMatches(x, chainId)) throw new Error(`the newer payment with nonce ${x.nonce} does not match its signed transaction; refusing to change the outbox`)
  }
  // the atomic decision: if the broadcaster claimed "send" a moment ago, it wins and nothing is changed
  const c = store.claim(claimKey(e), 'cancel')
  if (!c.ok && c.by !== 'cancel') throw new Error('this payment was just handed to the network; it can no longer be cancelled offline')
  const at = new Date(now).toISOString()
  const resign = []
  for (const x of newer.sort((a, b) => a.nonce - b.nonce)) {
    const cx = store.claim(claimKey(x), 'cancel')
    if (!cx.ok && cx.by !== 'cancel') continue // cannot happen (nonce order), and if it did, that entry stays as it is
    const previous = [...(Array.isArray(x.previous) ? x.previous : []), { hash: x.hash, nonce: x.nonce, error: 'withdrawn: an earlier payment was cancelled' }].slice(-5)
    resign.push(store.update(x.id, {
      status: 'needs_resign', raw: null, previous, resignReason: 'earlier_cancelled', // a hold it had stays
      error: `an earlier payment (nonce ${e.nonce}) was cancelled; sign this one again to keep it`
    }))
  }
  const entry = store.update(e.id, { status: 'cancelled', raw: null, cancelledAt: at, error: null })
  return { entry, resign }
}
