// What the UI shows for an analysis: grouped checks (passed / warning / blocked), the questions the person
// can answer (amount, contact), and display-safe recipient details. Plain code, no model, no network.
// Everything here is derived from the code checks in safety.js; the model's words never decide a status.
import { amountsInText, canonicalAmount, fromUnits } from './amount.js'
import { resolveRecipient } from './contacts.js'
import { shortAddr } from './text.js'
import { canCancel, isHeld } from './undo.js'

export const RELATION_TEXT = {
  brother: { sw: 'kaka', en: 'brother' },
  sister: { sw: 'dada', en: 'sister' },
  mother: { sw: 'mama', en: 'mother' },
  father: { sw: 'baba', en: 'father' },
  son: { sw: 'mwana', en: 'son' },
  daughter: { sw: 'binti', en: 'daughter' },
  landlord: { sw: 'mwenye nyumba', en: 'landlord' },
  wife: { sw: 'mke', en: 'wife' },
  husband: { sw: 'mume', en: 'husband' },
  friend: { sw: 'rafiki', en: 'friend' },
  school: { sw: 'shule', en: 'school' }
}

// Each group lists the reason codes it owns; a group passes when none of its codes fired.
const GROUPS = [
  { id: 'recipient', codes: ['missing_recipient', 'unknown_recipient', 'ambiguous_recipient', 'did_you_mean', 'recipient_not_in_request', 'relation_conflict', 'name_address_mismatch', 'new_recipient', 'self_send'] },
  { id: 'address', codes: ['bad_address', 'bad_checksum', 'zero_address', 'lookalike_address', 'token_contract_recipient'] },
  { id: 'amount', codes: ['missing_amount', 'amount_not_heard', 'amount_not_in_request', 'unsupported_token', 'token_assumed'] },
  { id: 'limits', codes: ['over_tx_limit', 'over_daily_limit', 'new_recipient_over_limit'] },
  { id: 'balance', codes: ['insufficient_balance', 'balance_unknown'] },
  { id: 'scam', codes: ['scam_high', 'scam_signals'] }
]

const PASSED = {
  recipient: { sw: (v) => `${v.name} yuko kwenye anwani zako`, en: (v) => `${v.name} is in your contacts` },
  address: { sw: (v) => (v.saved ? 'Anwani ni ile ile uliyohifadhi' : 'Anwani ni sahihi (checksum)'), en: (v) => (v.saved ? 'Same address you saved' : 'Address is valid (checksum)') },
  amount: { sw: (v) => `Kiasi ${v.amount} kimo kwenye maneno yako`, en: (v) => `The amount ${v.amount} is in your own words` },
  limits: { sw: (v) => `Ndani ya vikomo: ${v.perTx} kwa malipo, ${v.perDay} kwa siku`, en: (v) => `Within limits: ${v.perTx} per payment, ${v.perDay} per day` },
  balance: { sw: (v) => `Salio linatosha (${v.balance} USDT ya majaribio)`, en: (v) => `Enough balance (${v.balance} test USDT)` },
  scam: { sw: () => 'Hakuna dalili za utapeli', en: () => 'No scam signs' }
}

export const GROUP_TITLE = {
  recipient: { sw: 'Mpokeaji', en: 'Recipient' },
  address: { sw: 'Anwani', en: 'Address' },
  amount: { sw: 'Kiasi', en: 'Amount' },
  limits: { sw: 'Vikomo', en: 'Limits' },
  balance: { sw: 'Salio', en: 'Balance' },
  scam: { sw: 'Utapeli', en: 'Scam check' }
}

const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'

export function contactView (c) {
  return {
    id: c.id,
    name: c.name,
    initials: initials(c.name),
    relation: c.relation,
    relation_sw: c.relation ? RELATION_TEXT[c.relation]?.sw ?? null : null,
    relation_en: c.relation ? RELATION_TEXT[c.relation]?.en ?? null : null,
    address: c.address,
    short: shortAddr(c.address)
  }
}

/**
 * @param {object} a analysis from buildAnalysis()
 * @param {object} ctx { contacts, limits, balanceUnits }
 */
export function analysisView (a, ctx) {
  if (!a.ok) return { ok: false, transcript: a.transcript, errors: a.errors }
  const codes = new Set(a.reasons.map((r) => r.code))
  const r = a.recipient
  const recipient = r
    ? {
        name: r.name || null,
        saved: !!r.contact,
        initials: r.name ? initials(r.name) : '0x',
        relation: r.contact?.relation || null,
        relation_sw: r.contact?.relation ? RELATION_TEXT[r.contact.relation]?.sw ?? null : null,
        relation_en: r.contact?.relation ? RELATION_TEXT[r.contact.relation]?.en ?? null : null,
        address: r.address,
        short: shortAddr(r.address),
        via: r.via || null
      }
    : null
  const vars = {
    name: recipient?.name || '',
    saved: !!recipient?.saved,
    amount: a.intent.amount,
    perTx: ctx.limits.perTx,
    perDay: ctx.limits.perDay,
    balance: ctx.balanceUnits !== null && ctx.balanceUnits !== undefined ? fromUnits(ctx.balanceUnits) : '?'
  }
  const isSend = a.intent.action === 'send'
  const groups = isSend
    ? GROUPS.map((g) => {
        const rs = a.reasons.filter((x) => g.codes.includes(x.code))
        const status = rs.some((x) => x.severity === 'block') ? 'block' : rs.some((x) => x.severity === 'warn') ? 'warn' : 'ok'
        // a group with nothing to check yet (no recipient -> no address) is skipped instead of "passed"
        if (status === 'ok' && g.id === 'address' && !recipient) return null
        if (status === 'ok' && g.id === 'recipient' && !recipient?.saved) return null
        if (status === 'ok' && g.id === 'amount' && !a.intent.amount) return null
        const lines = status === 'ok' ? [{ severity: 'ok', sw: PASSED[g.id].sw(vars), en: PASSED[g.id].en(vars) }] : rs.map((x) => ({ code: x.code, severity: x.severity, sw: x.sw, en: x.en }))
        return { id: g.id, title: GROUP_TITLE[g.id], status, lines }
      }).filter(Boolean)
    : []

  // Questions the person can answer without starting again.
  const amountProblem = ['missing_amount', 'amount_not_heard', 'amount_not_in_request'].some((c) => codes.has(c))
  let amountQuestion = null
  if (isSend && amountProblem) {
    const heard = [...amountsInText(a.checkText)].map((x) => canonicalAmount(x)).filter((x) => x && !/^0+(\.0+)?$/.test(x) && x !== a.intent.amount)
    const uniq = [...new Set(heard)].slice(0, 3)
    amountQuestion = uniq.length === 1 ? { kind: 'did_you_mean', amount: uniq[0] } : uniq.length > 1 ? { kind: 'choose', amounts: uniq } : { kind: 'ask' }
  }
  let contactQuestion = null
  if (isSend && !a.intent.recipient_address) {
    if (codes.has('recipient_not_in_request') && r?.contact) {
      // the model named a saved contact the person never said: ask "did you mean X?" with that one contact
      contactQuestion = { kind: 'did_you_mean', said: a.intent.recipient_name, candidates: [contactView(r.contact)] }
    } else if (codes.has('did_you_mean') || codes.has('ambiguous_recipient')) {
      const res = resolveRecipient(a.intent.recipient_name, ctx.contacts)
      const cands = (res.candidates || []).slice(0, 5).map(contactView)
      if (cands.length) contactQuestion = { kind: codes.has('did_you_mean') ? 'did_you_mean' : 'ambiguous', said: a.intent.recipient_name, candidates: cands }
    } else if (codes.has('unknown_recipient') || codes.has('missing_recipient')) {
      contactQuestion = { kind: 'pick', said: a.intent.recipient_name || null, candidates: ctx.contacts.slice(0, 12).map(contactView) }
    }
  }
  // Only these blocks can be resolved by answering a question; anything else (scam, poisoning, limits) cannot.
  const answerable = new Set(['missing_amount', 'amount_not_heard', 'amount_not_in_request', 'did_you_mean', 'ambiguous_recipient', 'unknown_recipient', 'missing_recipient', 'recipient_not_in_request'])
  const hardBlock = a.reasons.some((x) => x.severity === 'block' && !answerable.has(x.code))

  const scamFlags = a.flags.filter((f) => f.source !== 'model').map((f) => ({ id: f.id, sw: f.sw, en: f.en }))
  const aiFlags = a.flags.filter((f) => f.source === 'model').map((f) => f.id)
  return {
    ok: true,
    action: a.intent.action,
    transcript: a.transcript,
    intent: a.intent,
    notes: a.notes,
    decision: a.decision,
    amount: a.intent.amount,
    token: 'USDT',
    memo: a.intent.memo,
    recipient,
    groups,
    needsRetype: a.needsRetype,
    amountQuestion,
    contactQuestion,
    hardBlock,
    scamFlags,
    aiFlags,
    aiNote: a.aiNote,
    risk: a.risk,
    lang: a.lang,
    amendments: a.amendments
  }
}

/** Outbox entry for display: public data only (no raw transaction). */
export function outboxView (e, net, store = null, now = Date.now()) {
  const linkable = net.explorer && ['broadcast', 'confirmed', 'failed'].includes(e.status)
  return {
    id: e.id,
    status: e.status,
    nonce: e.nonce,
    amount: e.amount,
    recipientName: e.recipientName || null,
    to: e.to,
    short: shortAddr(e.to),
    hash: e.hash,
    hashShort: `${e.hash.slice(0, 10)}…${e.hash.slice(-6)}`,
    memo: e.memo || null,
    created: e.created,
    updated: e.updated || null,
    broadcastAt: e.broadcastAt || null,
    block: e.block ?? null,
    explorer: linkable ? `${net.explorer}${e.hash}` : null,
    error: e.error ? String(e.error).slice(0, 160) : null,
    resigned: Array.isArray(e.previous) ? e.previous.length : 0,
    signedOffline: !!e.signedOffline,
    // undo window (src/undo.js)
    holdUntil: e.holdUntil || null,
    holdReasons: Array.isArray(e.holdReasons) ? e.holdReasons.slice(0, 4) : [],
    held: isHeld(e, now),
    cancelledAt: e.cancelledAt || null,
    cancellable: store ? canCancel(e, store) : false,
    resignReason: e.resignReason || null
  }
}
