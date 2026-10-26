// Local language model via QVAC (@qvac/sdk -> llama.cpp). Runs fully on device.
// The model gets text in and JSON out (grammar-constrained). It has no tools, no network, no files:
// everything it returns is re-validated in code (intent.js) and only ever ADVISES the safety engine.
import { loadModel, completion, unloadModel, deleteCache } from '@qvac/sdk'
import { INTENT_JSON_SCHEMA, validateIntent, MAX_MODEL_OUTPUT } from './intent.js'
import { FLAG_IDS } from './scam.js'
import { clean } from './text.js'

const INTENT_SYSTEM = `Turn a payment request (English or Swahili, maybe from speech recognition with glued or misspelled words: "ku Amina" = "kwa Amina", "ust" = "USDT", "kuminatano" = "kumi na tano") into JSON.
action: "send" (tuma, mtumie, nitumie, lipa, send, pay), "balance" (salio, balance), "check_message" (is this message safe?), else "unknown".
amount: USDT amount as digits in a string. Number words: moja 1, mbili 2, tano 5, kumi 10, kumi na tano 15, ishirini 20, thelathini 30, arobaini 40, hamsini 50, mia moja 100, elfu moja 1000. null when no amount is said. Never guess an amount.
token: "USDT" for USDT/ust/dola/dollars/tether; the name of any other token; null if none.
recipient_name: the payee as said ("Amina", "kaka yangu Juma", "my brother"), with speech glue removed ("kuwanjiru" -> "Wanjiru"); null if none. Never invent one.
recipient_address: a 0x address if present, else null.
memo: short purpose ("kodi", "rent", "karo ya shule") or null.
language: "sw" or "en".`

const INTENT_SHOTS = [
  ['Tuma USDT ishirini kwa Amina kwa ajili ya kodi.', { action: 'send', amount: '20', token: 'USDT', recipient_name: 'Amina', recipient_address: null, memo: 'kodi', language: 'sw' }],
  ['send fifteen usdt to my brother for school fees', { action: 'send', amount: '15', token: 'USDT', recipient_name: 'my brother', recipient_address: null, memo: 'school fees', language: 'en' }],
  ['Mtumie mama ust mia moja na hamsini', { action: 'send', amount: '150', token: 'USDT', recipient_name: 'mama', recipient_address: null, memo: null, language: 'sw' }],
  ['tuma kwa Otieno', { action: 'send', amount: null, token: null, recipient_name: 'Otieno', recipient_address: null, memo: null, language: 'sw' }],
  ['Salio langu ni kiasi gani?', { action: 'balance', amount: null, token: null, recipient_name: null, recipient_address: null, memo: null, language: 'sw' }]
]

const SCAM_SYSTEM = `You check a text message (English or Swahili) that asks someone to send money or crypto. List which warning signs it contains, choosing ONLY from this list:
${FLAG_IDS.join(', ')}.
Meanings: seed_request = asks for seed phrase, recovery words, PIN or password; remote_access = asks to install AnyDesk/TeamViewer or share screen; unlock_fee = pay first to unlock, release or receive money; wrong_send = says money was sent by mistake and asks to send it back; new_address_claim = says a person changed their wallet/address; impersonation = claims to be M-Pesa, Safaricom, a bank, customer care, exchange support or a government office; urgency = pressure, deadlines or threats (account will be closed); prize = says you won something; secrecy = tells you not to tell anyone; investment = promises profit or doubling; link = contains a web link.
Also write "summary": one short sentence in the message's language explaining the main risk, or that you found no warning sign.
Output only JSON.`

const SCAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['flags', 'summary', 'language'],
  properties: {
    flags: { type: 'array', items: { type: 'string', enum: FLAG_IDS }, maxItems: 11 },
    summary: { type: 'string', maxLength: 220 },
    language: { type: 'string', enum: ['sw', 'en'] }
  }
}

// One caller-managed KV-cache key per task. Files live under HOME/.qvac (the project's own home/ in the sandbox).
const CACHE_KEYS = { intent: 'sauti-intent-v1', scam: 'sauti-scam-v1' }

export class LocalLLM {
  /**
   * @param {object} o
   * @param {boolean} [o.cache] reuse the fixed system + few-shot prefix through QVAC's KV cache (one
   *   caller-managed key per task). The addon keeps the longest prefix a new prompt shares with the cached
   *   tokens, so only the person's request and the answer are computed on a warm turn.
   */
  constructor ({ modelPath, threads, ctxSize = 2048, cache = true } = {}) {
    this.modelPath = modelPath
    this.threads = threads
    this.ctxSize = ctxSize
    this.cache = cache
    this.modelId = null
    this.stats = []
  }

  async load () {
    const t = Date.now()
    this.modelId = await loadModel({
      modelSrc: this.modelPath,
      modelType: 'llamacpp-completion',
      modelConfig: {
        ctx_size: this.ctxSize,
        device: 'cpu',
        temp: 0,
        reasoning_budget: 0,
        ...(this.threads ? { threads: this.threads } : {})
      }
    })
    this.loadMs = Date.now() - t
    if (this.cache) await this._dropCaches() // files of an earlier process are keyed by its model id: stale
    return this.loadMs
  }

  async _dropCaches () {
    for (const k of Object.values(CACHE_KEYS)) { try { await deleteCache({ kvCacheKey: k }) } catch {} }
  }

  /** Compute the fixed prefixes once (after load) so the first real request is already warm. */
  async warm () {
    const t = Date.now()
    await this.parseIntent('Tuma USDT 5 kwa Amina.')
    await this.scamOpinion('Habari, tukutane kesho.')
    this.stats.length = 0
    return Date.now() - t
  }

  async _json (task, system, shots, user, schema, maxTokens) {
    const history = [{ role: 'system', content: system }]
    for (const [q, a] of shots) history.push({ role: 'user', content: q }, { role: 'assistant', content: JSON.stringify(a) })
    history.push({ role: 'user', content: clean(user, 1500) })
    const t = Date.now()
    const run = completion({
      modelId: this.modelId,
      history,
      stream: true,
      generationParams: { temp: 0, predict: maxTokens, reasoning_budget: 0, seed: 7 },
      responseFormat: { type: 'json_schema', json_schema: { name: 'out', schema } },
      ...(this.cache ? { kvCache: CACHE_KEYS[task] } : {})
    })
    let text = ''
    for await (const ev of run.events) {
      if (ev.type === 'contentDelta') {
        text += ev.text
        if (text.length > MAX_MODEL_OUTPUT) break
      }
    }
    const final = await run.final
    const s = final?.stats || {}
    this.stats.push({ task, ms: Date.now() - t, cached: !!this.cache, ...pickStats(s) })
    return text.trim()
  }

  /** @returns {Promise<{ok:boolean, intent?:object, errors?:string[], raw:string, ms:number}>} */
  async parseIntent (text) {
    const raw = await this._json('intent', INTENT_SYSTEM, INTENT_SHOTS, text, INTENT_JSON_SCHEMA, 160)
    return { ...validateIntent(raw), raw, ms: this.stats.at(-1).ms }
  }

  /** Second opinion on scam signs. Only known flag ids survive; the summary is display-only text. */
  async scamOpinion (text) {
    const raw = await this._json('scam', SCAM_SYSTEM, [], text, SCAM_SCHEMA, 160)
    let obj = null
    try { obj = JSON.parse(raw) } catch { return { ok: false, flags: [], summary: null, raw } }
    const flags = Array.isArray(obj?.flags) ? obj.flags.filter((f) => typeof f === 'string' && FLAG_IDS.includes(f)) : []
    const summary = typeof obj?.summary === 'string' ? clean(obj.summary, 220) : null
    return { ok: true, flags: [...new Set(flags)], summary: summary && !degenerate(summary) ? summary : null, raw, ms: this.stats.at(-1).ms }
  }

  async unload () {
    if (this.modelId) await unloadModel({ modelId: this.modelId })
    this.modelId = null
    if (this.cache) await this._dropCaches()
  }
}

/** Small models sometimes loop ("kwa kula kwa kula ..."): drop such text instead of showing it. */
export function degenerate (text) {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean)
  const seen = new Map()
  for (let i = 0; i + 2 < w.length; i++) {
    const k = w.slice(i, i + 3).join(' ')
    seen.set(k, (seen.get(k) || 0) + 1)
    if (seen.get(k) >= 3) return true
  }
  return false
}

function pickStats (s) {
  const out = {}
  for (const k of ['promptTokens', 'cacheTokens', 'generatedTokens', 'tokensPerSecond', 'timeToFirstToken', 'promptTokensPerSecond', 'predictedPerSecond', 'predicted_per_second', 'prompt_per_second', 'tps', 'ttft']) {
    if (s[k] !== undefined) out[k] = s[k]
  }
  if (!Object.keys(out).length && s && typeof s === 'object') Object.assign(out, Object.fromEntries(Object.entries(s).slice(0, 8)))
  return out
}
