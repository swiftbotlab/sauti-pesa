// LLM benchmark: intent extraction + scam second opinion with QVAC, fully offline.
//   ops/sandbox.sh offline node scripts/bench_llm.mjs models/Qwen3-1.7B-Q4_0.gguf
import { readFileSync } from 'node:fs'
import { close } from '@qvac/sdk'
import { LocalLLM } from '../src/llm.js'
import { resolveRecipient, validateContact } from '../src/contacts.js'
import { checkMessage } from '../src/safety.js'
import { normalizeNumbers } from '../src/amount.js'
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
for (const c of cases.intent) {
  const r = await llm.parseIntent(process.env.LLM_NO_NORMALIZE ? c.text : normalizeNumbers(c.text))
  const it = r.intent || {}
  let who = null
  if (it.recipient_address) who = 'address'
  else if (it.recipient_name) { const res = resolveRecipient(it.recipient_name, contacts); who = res.status === 'resolved' ? res.contact.id : res.status }
  const ok = r.ok && it.action === c.action && (it.amount ?? null) === c.amount && who === c.who
  if (ok) good++
  console.log(JSON.stringify({ ok, ms: r.ms, text: c.text, got: r.ok ? { a: it.action, amt: it.amount, name: it.recipient_name, who, memo: it.memo, lang: it.language } : r.errors, stats: llm.stats.at(-1) }))
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
console.log(JSON.stringify({ summary: true, model: process.argv[2], kv_cache: cache, load_ms: loadMs, warm_ms: warmMs, median_intent_ms: im[Math.floor(im.length / 2)], mean_scam_ms: Math.round(llm.stats.filter((x) => x.task === 'scam').reduce((a, s) => a + s.ms, 0) / cases.scam.length), intent_correct: `${good}/${cases.intent.length}`, scam_correct: `${scamGood}/${cases.scam.length}`, mean_intent_ms: Math.round(llm.stats.slice(0, cases.intent.length).reduce((a, s) => a + s.ms, 0) / cases.intent.length), peak_rss_mb: peakRssMb() }))
await llm.unload()
await close()
