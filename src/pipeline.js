// The offline flow: words -> local AI intent -> code safety checks -> confirmation -> WDK signature -> outbox.
// Nothing in this file touches the network. Broadcasting is a separate step (bin/netsync.mjs).
import { checkSend, checkMessage } from './safety.js'
import { ruleFlags } from './scam.js'
import { extractAddresses } from './evmaddr.js'
import { reasonText, confirmationText, FLAG_TEXT, RISK_TEXT } from './i18n.js'
import { fromUnits, canonicalAmount, normalizeNumbers } from './amount.js'
import { clean } from './text.js'
import { describeRaw } from './txdecode.js'
import { holdFor, claimKey } from './undo.js'
import { randomUUID } from 'node:crypto'

// Fee floors for signing offline: the cached fee data may be stale by the time the network is back.
export const OFFLINE_FEE_DEFAULTS = {
  devnet: { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  sepolia: { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }
}
export const DEFAULT_GAS_LIMIT = 90_000n

/**
 * Analyse a payment request. `llm` must expose parseIntent(text) and scamOpinion(text).
 * @returns analysis object with everything needed to show the confirmation screen
 */
export async function analyzeRequest ({ text, llm, contacts, store, ownAddress, tokenAddress, limits, useModelScamOpinion = true }) {
  const transcript = clean(text, 1000)
  if (!transcript) throw new Error('empty request')
  const forModel = normalizeNumbers(transcript) // number words -> digits, deterministic, before the model
  const parsed = await llm.parseIntent(forModel)
  if (!parsed.ok) {
    return { transcript, ok: false, stage: 'intent', errors: parsed.errors, raw: parsed.raw, llmMs: parsed.ms }
  }
  const intent = parsed.intent
  // Addresses are NEVER taken from the model (a small model can corrupt a 42-character string); they are
  // copied from the person's own text by a regex, and more than one address blocks the request.
  const addrs = extractAddresses(transcript)
  if (addrs.length > 1) return { transcript, ok: false, stage: 'intent', errors: ['more than one address in the request; send one payment at a time'], llmMs: parsed.ms }
  if (intent.recipient_address && intent.recipient_address !== addrs[0]) parsed.notes.push('model_address_ignored')
  intent.recipient_address = addrs[0] || null
  let opinion = null
  // The model's scam opinion is only asked for when a rule already fired: on ordinary requests a small
  // model invents flags ("impersonation" for "pay Amina rent"), which would train people to ignore warnings.
  if (intent.action === 'send' && useModelScamOpinion && ruleFlags(transcript).length) opinion = await llm.scamOpinion(transcript)
  return buildAnalysis({
    transcript,
    checkText: transcript,
    forModel,
    intent,
    notes: parsed.notes,
    opinion,
    llmMs: parsed.ms + (opinion?.ms || 0),
    contacts,
    store,
    ownAddress,
    tokenAddress,
    limits
  })
}

/**
 * The deterministic half of the analysis: code safety checks on a validated intent. No model, no network.
 * `checkText` is the text the amount must appear in: the person's request, plus any amount the person
 * typed or tapped afterwards in the UI (see amendAnalysis).
 */
export function buildAnalysis ({ transcript, checkText, forModel, intent, notes = [], opinion = null, llmMs = 0, contacts, store, ownAddress, tokenAddress, limits, amendments = [] }) {
  const state = store.state()
  const check = checkSend({
    intent,
    transcript: checkText,
    contacts,
    history: store.history(),
    limits,
    balance: state.balance ? { units: state.balance.units, at: state.balance.at } : null,
    ownAddress,
    tokenContracts: tokenAddress ? [tokenAddress] : [],
    modelFlags: opinion?.flags || [],
    pickedContactId: [...amendments].reverse().find((x) => x.contactId)?.contactId
  })
  const lang = intent.language
  const lines = check.reasons.map((r) => ({ code: r.code, severity: r.severity, data: reasonData(r), sw: reasonText(r, 'sw'), en: reasonText(r, 'en') }))
  const flagLines = (check.flags || []).map((f) => ({ id: f.id, source: f.source, sw: FLAG_TEXT[f.id].sw, en: FLAG_TEXT[f.id].en }))
  return {
    ok: true,
    transcript,
    checkText,
    forModel,
    intent,
    notes,
    opinion,
    llmMs,
    amendments,
    decision: check.decision,
    recipient: check.recipient,
    amountUnits: check.amountUnits,
    needsRetype: check.reasons.some((r) => r.code === 'retype_amount'),
    reasons: lines,
    flags: flagLines,
    risk: check.risk || 'none',
    aiNote: opinion?.summary || null,
    confirmation: {
      sw: confirmationText({ intent, recipient: check.recipient, decision: check.decision }, 'sw'),
      en: confirmationText({ intent, recipient: check.recipient, decision: check.decision }, 'en')
    },
    lang
  }
}

// Only plain, display-safe data from a reason (codes, names, amounts, addresses), never objects.
function reasonData (r) {
  const out = {}
  for (const k of ['amount', 'limit', 'spent', 'balance', 'said', 'name', 'similarTo', 'similarAddress', 'token']) {
    if (typeof r[k] === 'string' || typeof r[k] === 'number') out[k] = String(r[k]).slice(0, 80)
  }
  for (const k of ['candidates', 'heard']) if (Array.isArray(r[k])) out[k] = r[k].slice(0, 5).map((x) => String(x).slice(0, 60))
  return out
}

/**
 * The person answered a question on the confirmation screen. Re-run the code checks WITHOUT the model:
 *  - { amount }: the person typed (or tapped "did you mean N?") the amount. It is added to checkText, so the
 *    "amount was said" rule still holds: the amount comes from the person, never from the model alone.
 *  - { contactId }: the person picked a contact for a did-you-mean / ambiguous / not-said name. Its name is
 *    added to checkText, so the "recipient was named" rule holds the same way.
 */
export function amendAnalysis (a, { amount, contactId } = {}, ctx) {
  if (!a?.ok) throw new Error('nothing to amend')
  const intent = { ...a.intent }
  let checkText = a.checkText
  const amendments = [...a.amendments]
  if (amount !== undefined) {
    const c = canonicalAmount(String(amount))
    if (!c || /^0+(\.0+)?$/.test(c)) throw new Error('amount must be a positive number (max 6 decimals)')
    intent.amount = c
    if (!intent.token) intent.token = 'USDT'
    checkText = `${checkText} [${c}]`
    amendments.push({ amount: c })
  }
  if (contactId !== undefined) {
    if (intent.recipient_address) throw new Error('this request has an address; a contact cannot replace it')
    const c = ctx.contacts.find((x) => x.id === contactId)
    if (!c) throw new Error('unknown contact')
    intent.recipient_name = c.name
    checkText = `${checkText} [${c.name}]` // the person picked this contact: it now counts as named by them
    amendments.push({ contactId: c.id })
  }
  if (amendments.length > 6) throw new Error('too many changes; start again')
  return buildAnalysis({ ...ctx, transcript: a.transcript, checkText, forModel: a.forModel, intent, notes: a.notes, opinion: a.opinion, llmMs: a.llmMs, amendments })
}

/** Fee fields for an offline signature: the cached fee data (+100% headroom) or safe test defaults. */
function offlineFees (networkId, state) {
  const def = OFFLINE_FEE_DEFAULTS[networkId] || OFFLINE_FEE_DEFAULTS.sepolia
  const max = (a, b) => (a > b ? a : b)
  const maxPriorityFeePerGas = max(state.fees ? BigInt(state.fees.maxPriorityFeePerGas) : 0n, def.maxPriorityFeePerGas)
  const maxFeePerGas = max(max(state.fees ? BigInt(state.fees.maxFeePerGas) * 2n : 0n, def.maxFeePerGas), maxPriorityFeePerGas)
  const gasLimit = state.gasLimit ? BigInt(state.gasLimit) : DEFAULT_GAS_LIMIT
  return { maxFeePerGas, maxPriorityFeePerGas, gasLimit, feeSource: state.fees ? `cached ${state.fees.at}` : 'offline default' }
}

/**
 * The person said yes. Bind WDK's policy to exactly this transfer, sign offline, queue for broadcast.
 */
export async function confirmAndQueue ({ analysis, wallet, store, networkId, tokenAddress, retypedAmount, holdMinutes = 0, now = Date.now() }) {
  if (!analysis?.ok || analysis.decision === 'blocked') throw new Error('this payment is blocked and cannot be confirmed')
  if (!tokenAddress) throw new Error('token address unknown for this network (run the devnet setup or a sync first)')
  if (analysis.needsRetype && canonicalAmount(String(retypedAmount ?? '')) !== analysis.intent.amount) throw new Error('re-typed amount does not match')
  const state = store.state()
  const nonce = store.nextNonce()
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit, feeSource } = offlineFees(networkId, state)
  const to = analysis.recipient.address
  wallet.approve({ token: tokenAddress, to, amountUnits: analysis.amountUnits })
  const signed = await wallet.signTransfer({ token: tokenAddress, to, amountUnits: analysis.amountUnits, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas })
  return store.add({
    network: networkId,
    hash: signed.hash,
    raw: signed.raw,
    from: await wallet.address(),
    to,
    recipientName: analysis.recipient.name,
    token: tokenAddress,
    amount: fromUnits(analysis.amountUnits),
    amountUnits: analysis.amountUnits.toString(),
    memo: analysis.intent.memo,
    nonce,
    gasLimit: gasLimit.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    feeSource,
    signedOffline: true,
    signId: randomUUID(), // this signature's id: the send/cancel decision is made once per signature (src/queue.js)
    lang: analysis.lang,
    // undo window (src/undo.js): flagged payments wait in the outbox before the broadcaster may send them
    ...(holdFor(analysis, holdMinutes, now) || {})
  })
}

/**
 * Re-sign a queued payment whose nonce was used by another transaction (status "needs_resign", set by the
 * broadcaster after it checked that THIS transaction was not mined). Same token, recipient and amount as
 * the record the person confirmed earlier; a new nonce after the chain's last known one. The old signed
 * transaction can never be mined (its nonce is taken), so this does not create a second payment.
 * The caller must have asked the person to confirm the re-signature.
 */
export async function resignEntry ({ entryId, wallet, store, networkId, chainId }) {
  const e = store.list().find((x) => x.id === entryId)
  if (!e) throw new Error('no such outbox entry')
  if (e.status !== 'needs_resign') throw new Error(`entry is "${e.status}", only "needs_resign" entries can be re-signed`)
  const state = store.state()
  const nonce = store.nextNonce()
  if (e.resignReason === 'earlier_cancelled') {
    // An earlier payment was cancelled on this device (src/undo.js), so this one was withdrawn from the queue: its
    // signed bytes were deleted before they were ever sent, and its old signature carries a "cancel" claim the
    // broadcaster honours. It may take any free nonce, also a lower one; the record was checked against the
    // signed transaction when it was withdrawn.
    if (e.raw !== null && e.raw !== undefined) throw new Error('withdrawn entry still has signed bytes; refusing to re-sign')
    if (store.claimOf(claimKey(e))?.by !== 'cancel') throw new Error('withdrawn entry has no cancel record; refusing to re-sign')
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(e.to)) || !/^[0-9]{1,30}$/.test(String(e.amountUnits))) throw new Error('outbox record is damaged; refusing to re-sign')
  } else {
    const d = describeRaw(e.raw)
    if (d.hash !== e.hash || d.chainId !== chainId || !d.transfer || d.transfer.to !== e.to || d.transfer.amountUnits !== e.amountUnits || (d.to || '').toLowerCase() !== String(e.token).toLowerCase()) {
      throw new Error('outbox record does not match its signed transaction; refusing to re-sign')
    }
    if (nonce <= e.nonce) throw new Error(`no newer nonce known (chain at ${state.nonce}); sync first`)
  }
  const { maxFeePerGas, maxPriorityFeePerGas, gasLimit, feeSource } = offlineFees(networkId, state)
  wallet.approve({ token: e.token, to: e.to, amountUnits: BigInt(e.amountUnits) })
  const signed = await wallet.signTransfer({ token: e.token, to: e.to, amountUnits: BigInt(e.amountUnits), nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas })
  const previous = [...(Array.isArray(e.previous) ? e.previous : []), { hash: e.hash, nonce: e.nonce, error: e.error || null }].slice(-5)
  return store.update(e.id, {
    status: 'queued', raw: signed.raw, hash: signed.hash, nonce, previous, error: null,
    gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    feeSource, resignedAt: new Date().toISOString(), signedOffline: true, resignReason: null, signId: randomUUID()
  })
}

/** "Check this message" mode. */
export async function analyzeMessage ({ text, llm, contacts, history }) {
  const msg = clean(text, 2000)
  if (!msg) throw new Error('empty message')
  const opinion = llm ? await llm.scamOpinion(msg) : null
  const r = checkMessage({ text: msg, contacts, history, modelFlags: opinion?.flags || [] })
  const lang = /\b(na|kwa|ya|wa|tuma|habari|pesa|yako|hii)\b/i.test(msg) ? 'sw' : 'en'
  return {
    risk: r.risk,
    lang,
    headline: RISK_TEXT[r.risk],
    flags: r.flags.map((f) => ({ id: f.id, source: f.source, evidence: f.evidence, sw: FLAG_TEXT[f.id].sw, en: FLAG_TEXT[f.id].en })),
    addresses: r.addresses,
    aiNote: opinion?.summary || null,
    llmMs: opinion?.ms || 0
  }
}
