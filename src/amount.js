// Money amounts without floating point, and a small English + Swahili number-word reader.
// The reader is used to CROSS-CHECK the amount the language model extracted against what the
// person actually said: an amount that does not appear in the request is never accepted silently.
import { fold } from './text.js'

export const TOKEN_DECIMALS = 6 // USDT uses 6 decimals on every EVM chain we target
const AMOUNT_RE = /^\d{1,9}(\.\d{1,6})?$/

/** "1,000.5" | "20" -> canonical decimal string, or null if it is not a plain positive amount. */
export function canonicalAmount (s) {
  if (typeof s !== 'string' && typeof s !== 'number') return null
  let t = String(s).trim()
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '')
  if (!AMOUNT_RE.test(t)) return null
  t = t.replace(/^0+(?=\d)/, '')
  if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '')
  return t
}

export function toUnits (amount, decimals = TOKEN_DECIMALS) {
  const c = canonicalAmount(amount)
  if (c === null) throw new Error('invalid amount')
  const [i, f = ''] = c.split('.')
  if (f.length > decimals) throw new Error('too many decimals')
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0')
}

export function fromUnits (units, decimals = TOKEN_DECIMALS) {
  const u = BigInt(units)
  const neg = u < 0n
  const a = neg ? -u : u
  const base = 10n ** BigInt(decimals)
  const i = a / base
  const f = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${i}${f ? '.' + f : ''}`
}

// ---- number words -------------------------------------------------------------------------
const SW_UNITS = { sifuri: 0, moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9 }
const SW_TENS = { kumi: 10, ishirini: 20, thelathini: 30, arobaini: 40, hamsini: 50, sitini: 60, sabini: 70, themanini: 80, tisini: 90 }
const SW_ALIAS = { miya: 'mia', thalathini: 'thelathini', arubaini: 'arobaini', thamanini: 'themanini', tissini: 'tisini', hamsin: 'hamsini', ishrini: 'ishirini', elf: 'elfu' }
const EN_SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
}
const SW_VOCAB = new Set([...Object.keys(SW_UNITS), ...Object.keys(SW_TENS), 'mia', 'elfu', 'laki', 'na'])

// Speech recognisers often glue Swahili number words together ("kuminatano", "miamoja") or split
// them ("ham sini"). Re-segment a token into number words when it can be read fully that way.
function segment (tok) {
  if (SW_VOCAB.has(tok)) return [tok]
  const best = new Array(tok.length + 1).fill(null)
  best[0] = []
  for (let i = 0; i < tok.length; i++) {
    if (!best[i]) continue
    for (const w of [...SW_VOCAB, ...Object.keys(SW_ALIAS)]) {
      if (tok.startsWith(w, i) && !best[i + w.length]) best[i + w.length] = [...best[i], SW_ALIAS[w] || w]
    }
  }
  const seg = best[tok.length]
  return seg && seg.some((w) => w !== 'na') ? seg : null
}

function swTokens (text) {
  const raw = fold(text).replace(/-/g, ' ').split(' ').filter(Boolean)
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const joined = i + 1 < raw.length ? raw[i] + raw[i + 1] : null
    if (joined && !segment(raw[i]) && segment(joined)) { out.push(...segment(joined)); i++; continue }
    const s = segment(SW_ALIAS[raw[i]] || raw[i])
    out.push(...(s || [raw[i]]))
  }
  return out
}

// Swahili: [laki N] [elfu N] [mia N] [tens] [na] [unit]   (the count FOLLOWS mia/elfu/laki)
function readSwahili (toks, i) {
  let total = 0; let j = i; let used = false
  const small = (k) => { // 1..99 at position k
    let v = 0; let n = k
    if (SW_TENS[toks[n]] !== undefined) { v += SW_TENS[toks[n]]; n++ }
    if (toks[n] === 'na' && SW_UNITS[toks[n + 1]] !== undefined && v) { v += SW_UNITS[toks[n + 1]]; n += 2 } else if (!v && SW_UNITS[toks[n]] !== undefined) { v += SW_UNITS[toks[n]]; n++ }
    return n > k ? [v, n] : null
  }
  for (const [word, mult] of [['laki', 100000], ['elfu', 1000], ['mia', 100]]) {
    if (toks[j] === word) {
      const r = small(j + 1)
      total += mult * (r ? r[0] : 1); j = r ? r[1] : j + 1; used = true
      if (toks[j] === 'na' && toks[j + 1] !== undefined && (SW_TENS[toks[j + 1]] !== undefined || SW_UNITS[toks[j + 1]] !== undefined || toks[j + 1] === 'mia')) j++
    }
  }
  const r = small(j)
  if (r) { total += r[0]; j = r[1]; used = true }
  return used ? [total, j] : null
}

function readEnglish (toks, i) {
  let total = 0; let cur = 0; let j = i; let used = false
  while (j < toks.length) {
    const t = toks[j]
    if (EN_SMALL[t] !== undefined) { cur += EN_SMALL[t]; used = true } else if (t === 'hundred' && used) cur *= 100
    else if (t === 'thousand' && used) { total += cur * 1000; cur = 0 } else if (t === 'and' && used && EN_SMALL[toks[j + 1]] !== undefined) { /* "one hundred and five" */ } else break
    j++
  }
  return used ? [total + cur, j] : null
}

/**
 * Rewrite number words as digits BEFORE the language model sees the text:
 *   "tuma ust arobaini na tano kwa mama" -> "tuma ust 45 kwa mama".
 * A 1.7B model converts Swahili number words badly (held-out test: "kumi na mbili" -> 15, "mia mbili" -> 2);
 * this deterministic step means the model only has to copy digits. Returns the rewritten text.
 */
export function normalizeNumbers (text) {
  const parts = String(text || '').split(/(\s+)/) // words at even indexes, separators at odd ones
  const toks = [] // { t, from, to } from/to = indexes into parts
  for (let k = 0; k < parts.length; k += 2) {
    for (const sub of fold(parts[k]).replace(/-/g, ' ').split(' ').filter(Boolean)) toks.push({ t: sub, from: k, to: k })
  }
  const seq = []
  for (let i = 0; i < toks.length; i++) {
    const cur = toks[i]; const nxt = toks[i + 1]
    const joined = nxt ? cur.t + nxt.t : null
    if (joined && !segment(cur.t) && segment(joined)) { for (const s of segment(joined)) seq.push({ t: s, from: cur.from, to: nxt.to }); i++; continue }
    const s = segment(SW_ALIAS[cur.t] || cur.t)
    if (s) for (const x of s) seq.push({ t: x, from: cur.from, to: cur.to })
    else seq.push(cur)
  }
  const words = seq.map((x) => x.t)
  const repl = [] // { from, to, value }
  for (let i = 0; i < seq.length; i++) {
    const r = readSwahili(words, i) || readEnglish(words, i)
    if (!r) continue
    const [value, j] = r
    if (loneOne(words, i, j)) continue // "the one from church" is not an amount
    repl.push({ from: seq[i].from, to: seq[j - 1].to, value })
    i = j - 1
  }
  if (!repl.length) return String(text || '')
  const out = [...parts]
  for (const { from, to, value } of repl) {
    if (from % 2 || to % 2) continue
    const tail = (parts[to].match(/[.,!?;:]+$/) || [''])[0]
    out[from] = `${value}${tail}`
    for (let k = from + 1; k <= to; k++) out[k] = ''
  }
  return out.join('').replace(/\s{2,}/g, ' ').trim()
}

// "one" / "moja" on their own are usually not an amount ("the one from church", "siku moja" = one day). They only
// count next to a currency word ("one USDT", "dola moja") or inside a bigger number ("one hundred", "mia moja").
const CURRENCY_WORDS = new Set(['usdt', 'usdt0', 'usd', 'dollar', 'dollars', 'dola', 'bucks', 'tether', 'shilingi', 'shilling', 'shillings', 'ksh', 'kes', 'bob'])
function loneOne (toks, i, j) {
  if (j - i !== 1 || (toks[i] !== 'one' && toks[i] !== 'moja')) return false
  return !CURRENCY_WORDS.has(toks[i - 1]) && !CURRENCY_WORDS.has(toks[i + 1])
}

// Digits that stand on their own: not inside a word ("Juma2"), not part of a hex string (addresses are removed
// first), not glued to letters ("2k" is not 2), except a currency name written right after ("20usdt").
const HEX_RUN = /0x[0-9a-f]+/gi
const DIGITS = /(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?=$|[^\w]|(?:usdt0?|usd)(?![a-z0-9_]))/gi

/** Every amount mentioned in a request, as canonical decimal strings. */
export function amountsInText (text) {
  const found = new Set()
  // Addresses are not amounts: "0x23A5e0dC05105FEE..." contains "23", "05105", ... which must never count as said.
  const t = String(text || '').replace(HEX_RUN, ' ')
  for (const m of t.matchAll(DIGITS)) {
    const c = canonicalAmount(m[0]); if (c) found.add(c)
  }
  const sw = swTokens(t)
  for (let i = 0; i < sw.length; i++) {
    const r = readSwahili(sw, i); if (r && !loneOne(sw, i, r[1])) { found.add(String(r[0])); i = r[1] - 1 }
  }
  const en = fold(t).replace(/-/g, ' ').split(' ')
  for (let i = 0; i < en.length; i++) {
    const r = readEnglish(en, i); if (r && !loneOne(en, i, r[1])) { found.add(String(r[0])); i = r[1] - 1 }
  }
  return found
}
