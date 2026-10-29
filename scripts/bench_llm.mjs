// LLM benchmark: intent extraction + scam second opinion with QVAC, fully offline.
//   ops/sandbox.sh offline node scripts/bench_llm.mjs models/Qwen3-1.7B-Q4_0.gguf
//   LLM_CASES=test/llm_heldout.json ... (held-out set); models/Qwen3-0.6B-Q4_0.gguf = the lite profile's model
// Per request: the model's JSON (ok = action, amount and payee all right) and, for a payment, the decision of the
// app's code checks on it (src/safety.js checkSend), so a model mistake that would still reach "confirm" is counted.
import { readFileSync } from 'node:fs'
import { close } from '@qvac/sdk'
import { LocalLLM } from '../src/llm.js'
import { resolveRecipient, validateContact } from '../src/contacts.js'
import { checkMessage, checkSend } from '../src/safety.js'
import { normalizeNumbers, toUnits } from '../src/amount.js'
import { peakRssMb } from '../src/procmem.js'

const modelPath = `${process.cwd()}/${process.argv[2]}`
const cases = JSON.parse(readFileSync(process.env.LLM_CASES || 'test/llm_cases.json', 'utf8'))
const contacts = JSON.parse(readFileSync('data/demo-contacts.json', 'utf8')).map(validateContact)
// LLM_CACHE=0 measures the old path (whole prompt every request); default = KV-cached prefix
const cache = process.env.LLM_CACHE !== '0'
const llm = new LocalLLM({ modelPath, threads: Number(process.env.LLM_THREADS || 0) || undefined, cache })
const loadMs = await llm.load()
const warmMs = cache && process.env.LLM_WARM !== '0' ? await llm.warm() : 0
let good = 0
let wrongConfirmable = 0
for (const c of cases.intent) {
  const r = await llm.parseIntent(process.env.LLM_NO_NORMALIZE ? c.text : normalizeNumbers(c.text))
  const it = r.intent || {}
  let who = null
  if (it.recipient_address) who = 'address'
  else if (it.recipient_name) { const res = resolveRecipient(it.recipient_name, contacts); who = res.status === 'resolved' ? res.contact.id : res.status }
  const ok = r.ok && it.action === c.action && (it.amount ?? null) === c.amount && who === c.who
  if (ok) good++
  // what the app's code does with this answer (same inputs as scripts/bench_e2e.mjs): blocked, or on to the person's confirm
  const chk = r.ok && it.action === 'send' ? checkSend({ intent: it, transcript: c.text, contacts, history: [], balance: { units: toUnits('500'), at: 'bench' }, ownAddress: '0x1111111111111111111111111111111111111111' }) : null
  const decision = chk ? chk.decision : (r.ok ? `no payment (${it.action})` : 'not_understood')
  const confirmable = !!chk && chk.decision !== 'blocked'
  if (!ok && confirmable) wrongConfirmable++
  console.log(JSON.stringify({ ok, decision, confirmable, block_codes: chk ? chk.reasons.filter((x) => x.severity === 'block').map((x) => x.code) : [], ms: r.ms, text: c.text, got: r.ok ? { a: it.action, amt: it.amount, name: it.recipient_name, who, memo: it.memo, lang: it.language } : r.errors, stats: llm.stats.at(-1) }))
}
let scamGood = 0
for (const s of cases.scam) {
  const op = await llm.scamOpinion(s.text)
  const code = checkMessage({ text: s.text, contacts, modelFlags: op.flags })
  const ruleOnly = checkMessage({ text: s.text, contacts })
  const ok = (code.risk === 'high') === s.expect_high
  if (ok) scamGood++
  console.log(JSON.stringify({ ok, ms: op.ms, model_flags: op.flags, rule_risk: ruleOnly.risk, final_risk: code.risk, summary: op.summary }))
}
const im = llm.stats.filter((x) => x.task === 'intent').map((x) => x.ms).sort((a, b) => a - b)
console.log(JSON.stringify({ summary: true, model: process.argv[2], kv_cache: cache, load_ms: loadMs, warm_ms: warmMs, median_intent_ms: im[Math.floor(im.length / 2)], mean_scam_ms: Math.round(llm.stats.filter((x) => x.task === 'scam').reduce((a, s) => a + s.ms, 0) / cases.scam.length), intent_correct: `${good}/${cases.intent.length}`, wrong_but_confirmable: wrongConfirmable, scam_correct: `${scamGood}/${cases.scam.length}`, mean_intent_ms: Math.round(llm.stats.slice(0, cases.intent.length).reduce((a, s) => a + s.ms, 0) / cases.intent.length), peak_rss_mb: peakRssMb() }))
await llm.unload()
await close()
