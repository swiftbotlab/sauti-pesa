// Offline safety checks for a payment, in plain code. Nothing here calls the model or the network.
// Input: the validated intent + the original words + local state (contacts, history, limits, cached
// balance). Output: a decision ("blocked" | "confirm_with_warnings" | "confirm") and the reasons.
import { amountsInText, toUnits, fromUnits, normalizeNumbers, canonicalAmount } from './amount.js'
import { resolveRecipient, namedInText } from './contacts.js'
import { normalizeAddress, lookalike, extractAddresses } from './evmaddr.js'
import { ruleFlags, mergeFlags, riskFromFlags } from './scam.js'

export const DEFAULT_LIMITS = {
  perTx: '100', // USDT per payment
  perDay: '300', // USDT per rolling 24 h (queued + sent)
  newRecipientMax: '20', // first payment to an address that is not in the address book
  retypeAbove: '50' // above this the person must re-type the amount to confirm
}

const reason = (code, severity, data = {}) => ({ code, severity, ...data })

// Local money words. The app only sends USDT; "dola"/"dollar" are read as USDT on purpose (in this market a
// "dollar" balance usually means USDT), but shillings and mobile money are not. In a commissioned test set the
// model labelled "shilingi 2,000" as USDT: only the per-payment limit stopped 2,000 USDT. So the words decide.
// Saying "USDT" somewhere is not enough: "Tuma USDT kwa Juma, sawa na shilingi 50" names no USDT amount, so the 50
// is shillings. A shilling mention is only accepted next to an EXPLICIT USDT amount ("USDT 20 ... ni kama shilingi
// 2,600"), and then the payment must be that USDT amount, never the shilling one.
// Sheng amounts (thao = 1,000, soo = 100: src/amount.js) are shilling slang, so they count as a shilling word too.
const FIAT_WORDS = /\b(shilingi|shillings?|kshs?|kes|tshs?|tzs|ugx|m-?pesa|thao|soo)\b|\bsh\.? ?\d|\d[\d,.]* ?bob\b/i
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)'
const USDT_THEN_NUM = new RegExp(`\\b(?:usdt0?|tether)\\s*[:=]?\\s*${NUM}(?![\\w])`, 'gi')
const NUM_THEN_USDT = new RegExp(`(?<![\\w.,])${NUM}\\s*(?:usdt0?|tether)\\b`, 'gi')

/** USDT amounts written right next to the word USDT ("USDT 20", "20 USDT", "USDT ishirini"). */
export function explicitUsdtAmounts (text) {
  const t = normalizeNumbers(String(text || ''))
  const out = new Set()
  for (const re of [USDT_THEN_NUM, NUM_THEN_USDT]) for (const m of t.matchAll(re)) { const c = canonicalAmount(m[1]); if (c) out.add(c) }
  return out
}

/**
 * The local currency the person's words point to, or null. Returns null when no shilling / mobile-money word is
 * there, or when there is one but the request names an explicit USDT amount (and `amount`, if given, is it).
 */
export function fiatInText (text, amount) {
  const t = String(text || '')
  const m = t.match(FIAT_WORDS)
  if (!m) return null
  const explicit = explicitUsdtAmounts(t)
  if (explicit.size && (amount === undefined || amount === null || explicit.has(amount))) return null
  return m[0].replace(/[\d,. ]+/g, '').slice(0, 12) || 'shilingi'
}

/**
 * @param {object} p
 * @param {object} p.intent validated intent (validateIntent().intent)
 * @param {string} p.transcript what the person typed or said (after ASR)
 * @param {object[]} p.contacts address book
 * @param {object[]} p.history past payments [{to, amount, at}] (queued or sent)
 * @param {object} [p.limits]
 * @param {{units: bigint|string, at: string}|null} [p.balance] cached token balance from the last sync
 * @param {string} p.ownAddress
 * @param {string[]} p.tokenContracts token contract addresses (sending TO them burns money)
 * @param {string[]} [p.modelFlags] scam flags suggested by the model (closed list)
 * @param {string} [p.pickedContactId] a contact the person picked on the confirmation screen
 * @param {number} [p.now]
 */
export function checkSend (p) {
  const { intent, transcript = '', contacts = [], history = [], ownAddress, tokenContracts = [] } = p
  const limits = { ...DEFAULT_LIMITS, ...(p.limits || {}) }
  const now = p.now ?? Date.now()
  const reasons = []
  let recipient = null

  if (intent.action !== 'send') return { decision: 'blocked', reasons: [reason('not_a_payment', 'block')], recipient, amountUnits: null }

  // token
  const fiat = fiatInText(transcript, intent.amount)
  if (intent.token && intent.token !== 'USDT') reasons.push(reason('unsupported_token', 'block', { token: intent.token }))
  else if (fiat) reasons.push(reason('unsupported_token', 'block', { token: fiat }))
  else if (!intent.token) reasons.push(reason('token_assumed', 'warn', { token: 'USDT' }))

  // amount
  let amountUnits = null
  if (!intent.amount) reasons.push(reason('missing_amount', 'block'))
  else {
    amountUnits = toUnits(intent.amount)
    const said = amountsInText(transcript)
    // The model may "hear" an amount that was never said (seen in tests: "tuma kwa Otieno" -> 100).
    if (said.size === 0) reasons.push(reason('amount_not_heard', 'block', { amount: intent.amount }))
    else if (!said.has(intent.amount)) reasons.push(reason('amount_not_in_request', 'block', { amount: intent.amount, heard: [...said].slice(0, 5) }))
    if (amountUnits > toUnits(limits.perTx)) reasons.push(reason('over_tx_limit', 'block', { limit: limits.perTx }))
    const dayAgo = now - 24 * 3600 * 1000
    const spent = history.filter((h) => Date.parse(h.at) >= dayAgo && h.status !== 'failed').reduce((a, h) => a + BigInt(h.amountUnits), 0n)
    if (spent + amountUnits > toUnits(limits.perDay)) reasons.push(reason('over_daily_limit', 'block', { limit: limits.perDay, spent: fromUnits(spent) }))
    if (p.balance && p.balance.units !== undefined && p.balance.units !== null) {
      if (amountUnits > BigInt(p.balance.units)) reasons.push(reason('insufficient_balance', 'block', { balance: fromUnits(p.balance.units), at: p.balance.at }))
    } else reasons.push(reason('balance_unknown', 'warn'))
    if (amountUnits > toUnits(limits.retypeAbove)) reasons.push(reason('retype_amount', 'warn', { amount: intent.amount }))
  }

  // recipient
  const trusted = contacts.map((c) => ({ name: c.name, address: c.address }))
  for (const h of history) if (h.to && !trusted.some((t) => t.address.toLowerCase() === h.to.toLowerCase())) trusted.push({ name: null, address: h.to })
  let contact = null
  if (intent.recipient_address) {
    const n = normalizeAddress(intent.recipient_address)
    if (!n.ok) reasons.push(reason(n.code || 'bad_address', 'block', { detail: n.error }))
    else {
      recipient = { address: n.address, name: null, contact: null }
      contact = contacts.find((c) => c.address.toLowerCase() === n.address.toLowerCase()) || null
      if (contact) { recipient.contact = contact; recipient.name = contact.name }
      if (intent.recipient_name) {
        const r = resolveRecipient(intent.recipient_name, contacts)
        if (r.status === 'resolved' && r.contact.address.toLowerCase() !== n.address.toLowerCase()) {
          reasons.push(reason('name_address_mismatch', 'block', { name: r.contact.name, saved: r.contact.address, given: n.address }))
        }
      }
    }
  } else if (p.pickedContactId && contacts.some((c) => c.id === p.pickedContactId)) {
    // the person tapped this contact in the UI (did-you-mean / picker): their choice, not the model's
    contact = contacts.find((c) => c.id === p.pickedContactId)
    recipient = { address: contact.address, name: contact.name, contact, via: 'picked' }
  } else if (intent.recipient_name) {
    const r = resolveRecipient(intent.recipient_name, contacts)
    if (r.status === 'resolved') {
      contact = r.contact
      recipient = { address: contact.address, name: contact.name, contact, via: r.via }
      if (r.relationConflict) reasons.push(reason('relation_conflict', 'warn', { name: contact.name, ...r.relationConflict }))
      // The model may also invent WHO, like it can invent an amount: a test request with no name in it
      // ("Tuchange shilingi 2,000 kila mtu kwa chama") came back as recipient "Juma", a saved contact.
      // The contact must be named in the person's own words (or picked by the person in the UI).
      if (!namedInText(contact, r.via, transcript, contacts)) reasons.push(reason('recipient_not_in_request', 'block', { name: contact.name, said: intent.recipient_name }))
    } else if (r.status === 'ambiguous') reasons.push(reason('ambiguous_recipient', 'block', { candidates: r.candidates.map((c) => c.name) }))
    else if (r.status === 'did_you_mean') reasons.push(reason('did_you_mean', 'block', { said: intent.recipient_name, candidates: r.candidates.map((c) => c.name) }))
    else reasons.push(reason('unknown_recipient', 'block', { said: intent.recipient_name }))
  } else reasons.push(reason('missing_recipient', 'block'))

  if (recipient) {
    const a = recipient.address.toLowerCase()
    if (ownAddress && a === ownAddress.toLowerCase()) reasons.push(reason('self_send', 'warn'))
    if (tokenContracts.some((t) => t.toLowerCase() === a)) reasons.push(reason('token_contract_recipient', 'block'))
    if (!contact) {
      // Address poisoning: a new address that LOOKS like one the person already pays.
      for (const t of trusted) {
        const l = lookalike(recipient.address, t.address)
        if (l) reasons.push(reason('lookalike_address', l.level === 'high' ? 'block' : 'warn', { similarTo: t.name, similarAddress: t.address, ...l }))
      }
      const known = history.some((h) => h.to && h.to.toLowerCase() === a)
      if (!known) {
        reasons.push(reason('new_recipient', 'warn'))
        if (amountUnits !== null && amountUnits > toUnits(limits.newRecipientMax)) reasons.push(reason('new_recipient_over_limit', 'block', { limit: limits.newRecipientMax }))
      }
    }
  }

  // scam language in the request itself ("send 50 now to unlock your account")
  const flags = mergeFlags(ruleFlags(transcript), p.modelFlags)
  const risk = riskFromFlags(flags)
  if (risk === 'high') reasons.push(reason('scam_high', 'block', { flags: flags.map((f) => f.id) }))
  else if (risk === 'medium' || risk === 'low') reasons.push(reason('scam_signals', 'warn', { flags: flags.map((f) => f.id) }))

  const decision = reasons.some((r) => r.severity === 'block') ? 'blocked' : reasons.some((r) => r.severity === 'warn') ? 'confirm_with_warnings' : 'confirm'
  return { decision, reasons, recipient, amountUnits, flags, risk }
}

/** "Check this message" mode: risk of a pasted SMS/WhatsApp payment request. */
export function checkMessage ({ text, contacts = [], history = [], modelFlags = [] }) {
  const flags = mergeFlags(ruleFlags(text), modelFlags)
  const addresses = []
  for (const a of extractAddresses(text)) {
    const n = normalizeAddress(a)
    const entry = { address: a, valid: n.ok, issue: n.ok ? null : n.code || 'bad_address', knownAs: null, looksLike: [] }
    if (n.ok) {
      const c = contacts.find((x) => x.address.toLowerCase() === n.address.toLowerCase())
      if (c) entry.knownAs = c.name
      else {
        for (const t of [...contacts.map((c) => ({ name: c.name, address: c.address })), ...history.map((h) => ({ name: null, address: h.to }))]) {
          const l = lookalike(n.address, t.address)
          if (l) entry.looksLike.push({ name: t.name, address: t.address, level: l.level })
        }
      }
    }
    addresses.push(entry)
  }
  let risk = riskFromFlags(flags)
  if (addresses.some((a) => a.looksLike.some((l) => l.level === 'high') || a.issue === 'bad_checksum')) risk = 'high'
  return { risk, flags, addresses }
}
