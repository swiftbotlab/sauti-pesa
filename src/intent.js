// The payment intent: the ONLY thing the language model is allowed to produce.
// The JSON schema below is handed to QVAC (responseFormat json_schema -> llama.cpp GBNF grammar) so the
// model can only emit this shape; validateIntent() then re-checks every field in plain code, because a
// grammar constrains syntax, not meaning. Anything that fails is rejected, never "repaired" silently.
import { canonicalAmount } from './amount.js'
import { clean } from './text.js'

export const ACTIONS = ['send', 'check_message', 'balance', 'unknown']
export const LANGS = ['sw', 'en']
export const SUPPORTED_TOKENS = ['USDT']
const TOKEN_ALIASES = { USDT: 'USDT', USDT0: 'USDT', USD: 'USDT', USDTT: 'USDT', UST: 'USDT', DOLA: 'USDT', DOLLAR: 'USDT', DOLLARS: 'USDT', TETHER: 'USDT' }
const KEYS = ['action', 'amount', 'token', 'recipient_name', 'recipient_address', 'memo', 'language']
export const MAX_MODEL_OUTPUT = 2048

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] })
export const INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: KEYS,
  properties: {
    action: { type: 'string', enum: ACTIONS },
    amount: nullable({ type: 'string', maxLength: 16 }),
    token: nullable({ type: 'string', maxLength: 10 }),
    recipient_name: nullable({ type: 'string', maxLength: 60 }),
    recipient_address: nullable({ type: 'string', maxLength: 42 }),
    memo: nullable({ type: 'string', maxLength: 120 }),
    language: { type: 'string', enum: LANGS }
  }
}

const NAME_RE = /^[\p{L}][\p{L}\p{M} .'-]{0,59}$/u
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * @param {string|object} raw model output (string) or an already-parsed object
 * @returns {{ok: true, intent: object, notes: string[]} | {ok: false, errors: string[]}}
 */
export function validateIntent (raw) {
  let obj = raw
  if (typeof raw === 'string') {
    if (raw.length > MAX_MODEL_OUTPUT) return { ok: false, errors: ['model output too long'] }
    try { obj = JSON.parse(raw) } catch { return { ok: false, errors: ['model output is not valid JSON'] } }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['intent must be a JSON object'] }
  const errors = []; const notes = []
  const extra = Object.keys(obj).filter((k) => !KEYS.includes(k))
  if (extra.length) errors.push(`unexpected fields: ${extra.slice(0, 5).join(', ')}`)
  for (const k of KEYS) if (!(k in obj)) errors.push(`missing field: ${k}`)
  if (errors.length) return { ok: false, errors }

  // small models sometimes write the string "null" / "none" instead of JSON null
  const str = (v) => (v === null ? null : typeof v === 'string' ? (/^(null|none|n\/a|undefined|-)$/i.test(v.trim()) ? null : clean(v, 200)) : undefined)
  const out = {}
  out.action = ACTIONS.includes(obj.action) ? obj.action : errors.push('action not allowed')
  out.language = LANGS.includes(obj.language) ? obj.language : errors.push('language must be sw or en')

  const amount = str(obj.amount)
  if (amount === undefined) errors.push('amount must be a string or null')
  else if (amount === null || amount === '') out.amount = null
  else {
    const c = canonicalAmount(amount)
    if (c === null) errors.push('amount must be a positive number with at most 6 decimals')
    else if (/^0+(\.0+)?$/.test(c)) { out.amount = null; notes.push('zero_amount_as_missing') } // "nitumie Juma pesa" -> "0"
    else out.amount = c
  }

  const token = str(obj.token)
  if (token === undefined) errors.push('token must be a string or null')
  else if (!token) out.token = null
  else {
    const t = TOKEN_ALIASES[token.toUpperCase().replace(/[^A-Z0-9]/g, '')]
    if (t) { out.token = t; if (t !== token) notes.push(`token "${token}" read as ${t}`) } else { out.token = token.toUpperCase().slice(0, 10); notes.push('unsupported_token') }
  }

  const name = str(obj.recipient_name)
  if (name === undefined) errors.push('recipient_name must be a string or null')
  else if (!name) out.recipient_name = null
  else if (/0x[0-9a-f]{6,}/i.test(name)) { out.recipient_name = null; notes.push('name_was_address') } // the address is taken from the text, never from the model
  else if (!NAME_RE.test(name)) errors.push('recipient_name has characters that are not allowed')
  else out.recipient_name = name

  const addr = str(obj.recipient_address)
  if (addr === undefined) errors.push('recipient_address must be a string or null')
  else if (!addr) out.recipient_address = null
  else if (!ADDR_RE.test(addr)) errors.push('recipient_address is not a 0x address')
  else out.recipient_address = addr

  const memo = str(obj.memo)
  if (memo === undefined) errors.push('memo must be a string or null')
  else out.memo = memo ? memo.slice(0, 120) : null

  if (out.action === 'send' && !out.amount) notes.push('missing_amount')
  if (out.action === 'send' && !out.recipient_name && !out.recipient_address) notes.push('missing_recipient')
  return errors.length ? { ok: false, errors } : { ok: true, intent: out, notes }
}
