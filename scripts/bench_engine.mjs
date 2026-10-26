// Latency of the RESIDENT engine through the 127.0.0.1 bridge (what the UI sees), warm models + KV cache.
//   SAUTI_UI_PORT=8788 SAUTI_UI_TOKEN=<key> node scripts/bench_engine.mjs > tmp/bench_engine.jsonl  (engine + bridge running)
// Voice: POST /api/voice (WAV -> text) then POST /api/ask (text -> checked intent). Text: POST /api/ask.
// No payment is confirmed. Host-side, Node built-ins only.
import { readFileSync } from 'node:fs'
const B = `http://127.0.0.1:${Number(process.env.SAUTI_UI_PORT || 8787)}`
const H = { 'x-sauti-key': process.env.SAUTI_UI_TOKEN || '', origin: B } // the bridge's launch key (scripts/bench_latency.sh sets it)
const post = async (path, body, type) => {
  const t = performance.now()
  const r = await fetch(B + path, { method: 'POST', headers: { ...H, 'content-type': type }, body })
  return { j: await r.json(), ms: Math.round(performance.now() - t) }
}
const prompts = JSON.parse(readFileSync('test/audio/prompts.json', 'utf8'))
const cases = JSON.parse(readFileSync('test/llm_cases.json', 'utf8')).intent
const voice = []
for (const p of prompts) {
  const v = await post(`/api/voice?network=devnet&lang=${p.lang}`, readFileSync(`test/audio/${p.id}.wav`), 'audio/wav')
  const a = await post('/api/ask?network=devnet', JSON.stringify({ text: v.j.transcript }), 'application/json')
  const row = { id: p.id, audio_s: v.j.steps[0].audio_s, asr_ms: v.j.steps[0].ms, llm_ms: a.j.steps?.find((s) => s.id === 'llm')?.ms, http_total_ms: v.ms + a.ms, heard: v.j.transcript, amount: a.j.view?.amount ?? null, to: a.j.view?.recipient?.name ?? null, decision: a.j.view?.decision }
  voice.push(row); console.log(JSON.stringify(row))
}
const text = []
for (const c of cases) {
  const a = await post('/api/ask?network=devnet', JSON.stringify({ text: c.text }), 'application/json')
  const s = a.j.steps?.find((x) => x.id === 'llm') || {}
  const row = { text: c.text, llm_ms: s.ms, prompt_tokens: s.prompt_tokens, cached_tokens: s.cached_tokens, http_total_ms: a.ms, amount: a.j.view?.amount ?? null }
  text.push(row); console.log(JSON.stringify(row))
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const max = (xs) => Math.max(...xs)
console.log(JSON.stringify({ summary: true, voice_n: voice.length, voice_median_total_ms: med(voice.map((x) => x.http_total_ms)), voice_max_total_ms: max(voice.map((x) => x.http_total_ms)), asr_median_ms: med(voice.map((x) => x.asr_ms)), text_n: text.length, text_median_total_ms: med(text.map((x) => x.http_total_ms)), text_max_total_ms: max(text.map((x) => x.http_total_ms)), llm_median_ms: med(text.map((x) => x.llm_ms)), median_prompt_tokens_computed: med(text.map((x) => x.prompt_tokens)), median_prompt_tokens_cached: med(text.map((x) => x.cached_tokens)) }))
