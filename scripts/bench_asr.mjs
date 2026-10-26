// ASR benchmark: QVAC whisper (+ Silero VAD) on the synthetic test recordings, fully offline.
//   ops/sandbox.sh offline node scripts/bench_asr.mjs models/ggml-small-q8_0.bin [lang|auto]
// Prints one JSON line per file and a summary line.
import { readFileSync } from 'node:fs'
import { loadModel, transcribe, unloadModel, close } from '@qvac/sdk'
import { peakRssMb } from '../src/procmem.js'

const modelPath = process.argv[2]
const langArg = process.argv[3] || 'per-file'
const prompts = JSON.parse(readFileSync('test/audio/prompts.json', 'utf8'))
const t0 = Date.now()
const results = []
const byLang = new Map()

async function modelFor (lang) {
  if (byLang.has(lang)) return byLang.get(lang)
  const t = Date.now()
  const id = await loadModel({
    modelSrc: `${process.cwd()}/${modelPath}`,
    modelType: 'whispercpp-transcription',
    modelConfig: {
      language: lang,
      vadModelSrc: `${process.cwd()}/models/ggml-silero-v5.1.2.bin`,
      n_threads: Number(process.env.ASR_THREADS || 4),
      ...(process.env.ASR_AUDIO_CTX ? { audio_ctx: Number(process.env.ASR_AUDIO_CTX) } : {}),
      ...(process.env.ASR_FAST ? { no_timestamps: true, single_segment: true, contextParams: { flash_attn: true } } : {}),
      temperature: 0.0,
      strategy: 'greedy',
      suppress_nst: true,
      initial_prompt: process.env.ASR_SW_PROMPT && lang === 'sw' ? 'Tuma USDT kumi na tano kwa Amina. Mtumie kaka yangu Juma USDT mia moja. Wanjiru, Otieno, M-Pesa.' : 'USDT, Amina, Juma, Wanjiru, Otieno, M-Pesa.'
    }
  })
  byLang.set(lang, { id, loadMs: Date.now() - t })
  return byLang.get(lang)
}

for (const p of prompts) {
  const lang = langArg === 'per-file' ? p.lang : langArg
  const m = await modelFor(lang)
  const wav = `test/audio/${p.id}.wav`
  const audioSec = (readFileSync(wav).length - 44) / 32000
  const t = Date.now()
  const text = await transcribe({ modelId: m.id, audioChunk: `${process.cwd()}/${wav}` })
  const ms = Date.now() - t
  results.push({ id: p.id, lang, audio_s: +audioSec.toFixed(2), asr_ms: ms, rtf: +(ms / 1000 / audioSec).toFixed(2), text: String(text).trim(), truth: p.text })
  console.log(JSON.stringify(results.at(-1)))
}
for (const m of byLang.values()) await unloadModel({ modelId: m.id })
console.log(JSON.stringify({ summary: true, model: modelPath, threads: process.env.ASR_THREADS || 4, audio_ctx: process.env.ASR_AUDIO_CTX || 'default', fast: !!process.env.ASR_FAST, load_ms: [...byLang.values()].map((m) => m.loadMs), mean_asr_ms: Math.round(results.reduce((a, r) => a + r.asr_ms, 0) / results.length), worker_peak_rss_mb: peakRssMb(), total_s: (Date.now() - t0) / 1000 }))
await close()
