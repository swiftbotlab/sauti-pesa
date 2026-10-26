// Voice -> decision benchmark with the app's own modules, fully offline.
//   ops/sandbox.sh offline node scripts/bench_e2e.mjs [--accurate]
// Speech model first (all clips), unloaded, then the language model: the same order the CLI uses (RAM).
import { readFileSync } from 'node:fs'
import { close } from '@qvac/sdk'
import { LocalASR } from '../src/asr.js'
import { LocalLLM } from '../src/llm.js'
import { normalizeNumbers, toUnits } from '../src/amount.js'
import { validateContact } from '../src/contacts.js'
import { checkSend } from '../src/safety.js'
import { peakRssMb } from '../src/procmem.js'

const cfg = JSON.parse(readFileSync('config.json', 'utf8'))
const accurate = process.argv.includes('--accurate')
const root = process.cwd()
const prompts = JSON.parse(readFileSync('test/audio/prompts.json', 'utf8'))
const contacts = JSON.parse(readFileSync('data/demo-contacts.json', 'utf8')).map(validateContact)
const asr = new LocalASR({ modelPath: `${root}/${accurate ? cfg.models.asr_accurate : cfg.models.asr}`, vadPath: `${root}/${cfg.models.vad}`, threads: cfg.asr_threads, audioCtx: accurate ? cfg.asr_accurate_audio_ctx : 0, names: contacts.map((c) => c.name) })
const heard = []
for (const p of prompts) heard.push({ p, ...(await asr.transcribe(`${root}/test/audio/${p.id}.wav`, p.lang)) })
const asrRss = peakRssMb()
await asr.unload()
await close() // fresh worker, so the memory numbers below belong to the language model alone
const llm = new LocalLLM({ modelPath: `${root}/${cfg.models.llm}` })
const llmLoad = await llm.load()
let correct = 0
for (const h of heard) {
  const r = await llm.parseIntent(normalizeNumbers(h.text))
  const c = r.ok ? checkSend({ intent: r.intent, transcript: h.text, contacts, history: [], balance: { units: toUnits('500'), at: 'bench' }, ownAddress: '0x1111111111111111111111111111111111111111' }) : null
  const e = h.p.expect
  const got = { amount: r.intent?.amount ?? null, to: c?.recipient?.name ?? null, decision: c?.decision ?? 'not_understood' }
  const ok = e.scam ? got.decision === 'blocked' : (got.amount === e.amount && got.decision !== 'blocked' && (got.to || '').toLowerCase().startsWith(e.recipient === 'my brother' ? 'juma' : e.recipient.toLowerCase()))
  if (ok) correct++
  console.log(JSON.stringify({ id: h.p.id, ok, asr_ms: h.ms, audio_s: h.seconds, llm_ms: r.ms, heard: h.text, got, codes: c?.reasons.map((x) => x.code) }))
}
console.log(JSON.stringify({ summary: true, asr_model: accurate ? cfg.models.asr_accurate : cfg.models.asr, asr_load_ms: asr.loadMs, llm_load_ms: llmLoad, correct: `${correct}/${heard.length}`, mean_asr_ms: Math.round(heard.reduce((a, h) => a + h.ms, 0) / heard.length), mean_llm_ms: Math.round(llm.stats.reduce((a, s) => a + s.ms, 0) / llm.stats.length), asr_peak_rss_mb: asrRss, llm_peak_rss_mb: peakRssMb() }))
await llm.unload()
await close()
