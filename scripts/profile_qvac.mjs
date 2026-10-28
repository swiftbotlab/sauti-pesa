// QVAC profiler run: ONE offline pass over the app's own AI code paths, measured with the QVAC SDK's documented
// profiler (profiler.enable, profiler.onRecord, profiler.exportJSON; https://docs.qvac.tether.io/sdk/runtime/profiler).
//   scripts/profile_qvac.sh                                       runs this in the offline sandbox -> evidence/
//   ops/sandbox.sh offline node scripts/profile_qvac.mjs [out]    default out: tmp/profile/qvac-profile.json
//
// Order, as the resident engine does it (src/engine.js):
//   1. speech: Whisper small + Silero VAD (src/asr.js LocalASR, one instance, reload-config for sw/en): load, the
//      warm-up clip from config.json, then the 6 test voice notes (test/audio);
//   2. language model: Qwen3-1.7B (src/llm.js LocalLLM, KV-cached prompts): load, prompt-cache warm-up, then the 6
//      transcripts and the 12 test requests (test/llm_cases.json) through analyzeRequest(), and the 4 test scam
//      messages through analyzeMessage() (src/pipeline.js);
//   3. OCR: the speech model is unloaded (as in the engine); for each of the 4 test screenshots
//      (test/data/public/screens) QVAC OCR (src/ocr.js LocalOCR) is loaded, reads the image and is unloaded, and the
//      text is then checked like pasted text;
//   4. voice activity detection: the same voice notes plus 3 s of digital silence, transcribed once with the app's
//      Whisper config (VAD on) and once with the same config minus the VAD model, because the SDK reports no
//      separate VAD timing (VAD runs inside the transcription call).
// No wallet is opened and nothing is signed: analyzeRequest() only runs the model and the code checks.
// This is a plain performance log of our own SDK calls: it records what the SDK's profiler reports for them, the
// SDK's own per-call stats, and a wall clock around each step. It changes no setting of the app.
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { profiler, transcribe, loadModel, unloadModel, getSystemResources, close } from '@qvac/sdk'
import { LocalASR, inspectWav, levelAudio } from '../src/asr.js'
import { LocalLLM } from '../src/llm.js'
import { LocalOCR, inspectImage } from '../src/ocr.js'
import { analyzeRequest, analyzeMessage } from '../src/pipeline.js'
import { validateContact } from '../src/contacts.js'
import { Store } from '../src/queue.js'
import { NETWORKS } from '../src/networks.js'
import { networkProof } from '../src/offline.js'
import { clean } from '../src/text.js'

if (process.env.SAUTI_SANDBOX !== 'offline') {
  console.error('run it inside the offline sandbox: scripts/profile_qvac.sh (or ops/sandbox.sh offline node scripts/profile_qvac.mjs)')
  process.exit(2)
}
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const rel = (p) => relative(ROOT, p)
const CFG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const MODELS = JSON.parse(readFileSync(join(ROOT, 'models.json'), 'utf8'))
const OUT = resolve(ROOT, process.argv[2] || 'tmp/profile/qvac-profile.json')
if (!OUT.startsWith(join(ROOT, 'tmp') + '/') || !OUT.endsWith('.json')) throw new Error('output must be a .json file under tmp/')
const WORK = join(dirname(OUT), 'work') // a level-raised copy of a quiet clip, the silence clip, a throwaway outbox
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true, mode: 0o700 })

const modelFile = (key) => {
  const p = join(ROOT, CFG.models[key] || '')
  if (!CFG.models[key] || !existsSync(p)) throw new Error(`model missing: ${CFG.models[key]} (scripts/fetch_models.sh)`)
  return realpathSync(p)
}
const describeModel = (key) => {
  const file = CFG.models[key].split('/').pop()
  const [constant, m] = Object.entries(MODELS).find(([, v]) => v.file === file) || [null, {}]
  return { role: key, file, qvac_constant: m.qvac_constant ?? constant, bytes: m.bytes ?? null, sha256: m.sha256 ?? null, engine: m.engine ?? null }
}

// ------------------------------------------------------------------ profiler + step log
const events = [] // every event the profiler records, labelled with the step that was running
const steps = []
const resident = new Set() // which models are loaded in the QVAC worker (for reading the memory samples)
let current = null
let seq = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
profiler.enable({ mode: 'verbose', includeServerBreakdown: true, includeResourceGauges: true })
profiler.onRecord((e) => { events.push({ step: current?.seq ?? null, ...e }) })

// Each SDK call is awaited, so the events recorded while a step runs belong to it. The client records a call's
// events a few ms after the call returns, so the label stays until the profiler has been quiet for 100 ms.
async function step (capability, what, input, fn, change = null) {
  const s = { seq: ++seq, capability, what, ...(input ? { input } : {}) }
  current = s
  const t = performance.now()
  try {
    s.result = await fn()
    if (change) change()
  } finally {
    s.wall_ms = Math.round(performance.now() - t)
    for (let i = 0, n = -1; i < 30 && n !== events.length; i++) { n = events.length; await sleep(100) }
    s.resident = [...resident]
    current = null
    steps.push(s)
  }
  return s.result
}

// ------------------------------------------------------------------ inputs (all files in this repository)
const contacts = JSON.parse(readFileSync(join(ROOT, 'data/demo-contacts.json'), 'utf8')).map(validateContact)
const prompts = JSON.parse(readFileSync(join(ROOT, 'test/audio/prompts.json'), 'utf8'))
const cases = JSON.parse(readFileSync(join(ROOT, 'test/llm_cases.json'), 'utf8'))
const screensDir = join(ROOT, 'test/data/public/screens')
const screens = Object.keys(JSON.parse(readFileSync(join(screensDir, 'labels.json'), 'utf8')).screens)
const store = new Store(join(WORK, 'queue'), 'devnet') // empty throwaway outbox: no balance, no history
const ctx = { contacts, store, ownAddress: null, tokenAddress: NETWORKS.devnet.token.address, limits: CFG.limits }

// 3 s of digital silence, 16 kHz mono 16-bit PCM: only for the VAD comparison
const silence = join(WORK, 'silence_3s.wav')
{
  const n = 16000 * 3
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  writeFileSync(silence, b, { mode: 0o600 })
}

// The same steps as LocalASR.transcribe() (src/asr.js: content check, input gain, the model, the transcribe() call,
// clean()), written out so the run can also keep the SDK's own statistics of the call (call.stats).
async function transcribeLikeApp (modelId, wavPath) {
  const info = inspectWav(wavPath)
  const lv = levelAudio(wavPath, WORK)
  try {
    const call = transcribe({ modelId, audioChunk: lv.path })
    const text = clean(String(await call), 1000)
    const stats = await call.stats
    return { text, audio_s: +info.seconds.toFixed(2), input_gain_db: lv.info.gain_db ?? 0, sdk_stats: stats ?? null }
  } finally {
    lv.cleanup()
  }
}
const intentOut = (a) => (a.ok
  ? { ok: true, action: a.intent.action, amount: a.intent.amount, recipient: a.recipient?.name ?? a.intent.recipient_name ?? null, decision: a.decision, risk: a.risk }
  : { ok: false, stage: a.stage })

// ------------------------------------------------------------------ run
const startedAt = new Date().toISOString()
const tRun = performance.now()
const netBefore = await networkProof()
if (netBefore.online) throw new Error('the internet is reachable: run this in the offline sandbox (scripts/profile_qvac.sh)')
const systemResources = await getSystemResources({ sample: true }).catch((e) => ({ error: String(e.message).slice(0, 200) }))

// 1. speech
const names = contacts.map((c) => c.name)
const asr = new LocalASR({ modelPath: modelFile('asr'), vadPath: modelFile('vad'), threads: CFG.asr_threads || 4, names, single: true, tmpDir: WORK })
await step('asr', 'load', { lang: 'sw', model: 'asr+vad' }, () => asr.prepare('sw'), () => resident.add('whisper+vad'))
await step('asr', 'warm-up transcription', { clip: CFG.asr_warmup }, () => transcribeLikeApp(asr.current.id, join(ROOT, CFG.asr_warmup)))

// 2. language model (loaded next to the speech model, as in the engine)
const llm = new LocalLLM({ modelPath: modelFile('llm'), threads: CFG.llm_threads || undefined, cache: true })
await step('llm', 'load', null, () => llm.load(), () => resident.add('qwen3-1.7b'))
await step('llm', 'prompt-cache warm-up (2 completions)', null, () => llm.warm())

const llmCall = async (what, input, fn) => {
  const before = llm.stats.length
  const r = await step('llm', what, input, fn)
  steps.at(-1).app_llm_stats = llm.stats.slice(before)
  return r
}

const transcripts = []
for (const p of prompts) {
  if (asr.current?.lang !== p.lang) await step('asr', 'switch language (reload config)', { lang: p.lang }, () => asr.prepare(p.lang))
  const r = await step('asr', 'transcribe', { clip: `test/audio/${p.id}.wav`, lang: p.lang }, () => transcribeLikeApp(asr.current.id, join(ROOT, `test/audio/${p.id}.wav`)))
  transcripts.push({ id: p.id, text: r.text })
  await llmCall('voice request: analyzeRequest(transcript)', { clip: p.id, chars: r.text.length }, async () => intentOut(await analyzeRequest({ text: r.text, llm, ...ctx })))
}
for (const c of cases.intent) {
  await llmCall('text request: analyzeRequest(text)', { text: c.text, chars: c.text.length }, async () => intentOut(await analyzeRequest({ text: c.text, llm, ...ctx })))
}
for (const c of cases.scam) {
  await llmCall('message check: analyzeMessage(text)', { chars: c.text.length }, async () => ({ risk: (await analyzeMessage({ text: c.text, llm, contacts, history: store.history() })).risk }))
}

// 3. OCR, one load/read/unload per screenshot; the speech model is freed first, as in the engine
await step('asr', 'unload (engine frees speech before OCR)', null, () => asr.unload(), () => resident.delete('whisper+vad'))
for (const f of screens) {
  const buf = readFileSync(join(screensDir, f))
  const img = inspectImage(buf)
  const input = { image: `test/data/public/screens/${f}`, width: img.width, height: img.height, bytes: buf.length }
  const reader = new LocalOCR({ modelPath: modelFile('ocr'), detectorPath: modelFile('ocr_detector'), threads: CFG.ocr_threads || 4 })
  await step('ocr', 'load', input, () => reader.load(), () => resident.add('ocr'))
  const r = await step('ocr', 'read', input, async () => { const x = await reader.read(buf); return { chars: x.text.length, blocks: x.blocks, text: x.text } })
  await step('ocr', 'unload', input, () => reader.unload(), () => resident.delete('ocr'))
  await llmCall('message check: analyzeMessage(OCR text)', { image: f, chars: r.chars }, async () => ({ risk: (await analyzeMessage({ text: r.text, llm, contacts, history: store.history() })).risk }))
}

// 4. VAD on/off, same clips, same Whisper config otherwise; one Whisper instance in memory at a time
const vadClips = [...prompts.map((p) => ({ id: p.id, lang: p.lang, path: join(ROOT, `test/audio/${p.id}.wav`) })), { id: 'silence_3s (synthetic)', lang: 'sw', path: silence }]
  .sort((a, b) => (a.lang === b.lang ? 0 : a.lang === 'sw' ? -1 : 1))
for (const vad of [true, false]) {
  let id = null; let lang = null
  for (const c of vadClips) {
    if (lang !== c.lang) {
      const config = asr._config(c.lang)
      if (!vad) delete config.vadModelSrc
      const params = { modelType: 'whispercpp-transcription', modelConfig: config }
      if (id) await step('vad', 'switch language (reload config)', { vad, lang: c.lang }, () => loadModel({ modelId: id, ...params }))
      else id = await step('vad', 'load', { vad, lang: c.lang, model: vad ? 'asr+vad' : 'asr only' }, () => loadModel({ modelSrc: modelFile('asr'), ...params }), () => resident.add(vad ? 'whisper+vad' : 'whisper'))
      lang = c.lang
    }
    await step('vad', 'transcribe', { vad, clip: c.id, lang: c.lang }, () => transcribeLikeApp(id, c.path).catch((e) => ({ error: String(e.message).slice(0, 200), audio_s: null, text: '' })))
  }
  await step('vad', 'unload', { vad }, () => unloadModel({ modelId: id }), () => resident.delete(vad ? 'whisper+vad' : 'whisper'))
}

await step('llm', 'unload', null, () => llm.unload(), () => resident.delete('qwen3-1.7b'))
const netAfter = await networkProof()
const runWallMs = Math.round(performance.now() - tRun)
const exported = profiler.exportJSON({ includeRecentEvents: false })
const table = profiler.exportTable()
const summaryText = profiler.exportSummary()
profiler.disable()
await close()
rmSync(WORK, { recursive: true, force: true })

// ------------------------------------------------------------------ per-step view of the profiler events
const MB = (b) => (typeof b === 'number' ? Math.round(b / 1024 / 1024) : null)
const RPC_KEEP = ['totalClientTime', 'serverWait', 'server.handlerExecution', 'server.totalServerTime', 'ttfb']
for (const s of steps) {
  const evs = events.filter((e) => e.step === s.seq)
  s.profiler = {
    handler: evs.filter((e) => e.kind === 'handler').map((e) => ({ op: e.op, ms: e.ms, ...(e.gauges ? { gauges: e.gauges } : {}), ...(e.tags ? { tags: e.tags } : {}) })),
    rpc: evs.filter((e) => e.kind === 'rpc' && RPC_KEEP.includes(e.phase)).map((e) => ({ op: e.op, phase: e.phase, ms: e.ms })),
    resources: evs.filter((e) => e.resources).map((e) => ({
      op: e.op,
      cpu_system: e.resources.cpu?.status === 'supported' ? +e.resources.cpu.value.toFixed(3) : e.resources.cpu?.status ?? null,
      qvac_process_mb: e.resources.memory?.processUsedBytes?.status === 'supported' ? MB(e.resources.memory.processUsedBytes.value) : null,
      system_used_mb: e.resources.memory?.usedBytes?.status === 'supported' ? MB(e.resources.memory.usedBytes.value) : null
    }))
  }
  if (s.result && typeof s.result !== 'object') s.result = { value: s.result }
  if (s.result?.text && s.capability === 'ocr') s.result.text = s.result.text.slice(0, 400)
}

// ------------------------------------------------------------------ summary (only numbers the SDK reported)
const nums = (xs) => xs.filter((x) => typeof x === 'number' && Number.isFinite(x))
const stat = (xs) => {
  const v = nums(xs).sort((a, b) => a - b)
  if (!v.length) return null
  const r = (x) => +x.toFixed(x < 10 ? 3 : 1)
  return { n: v.length, median: r(v[Math.floor((v.length - 1) / 2)]), min: r(v[0]), max: r(v.at(-1)) }
}
const sel = (cap, what, pred = () => true) => steps.filter((s) => s.capability === cap && s.what.startsWith(what) && pred(s))
const rpcMs = (s, op, phase) => s.profiler.rpc.find((r) => r.op === op && r.phase === phase)?.ms
const handlers = (s, op) => s.profiler.handler.filter((h) => h.op === op)
const peakMb = (cap) => { const v = nums(steps.filter((s) => s.capability === cap).flatMap((s) => s.profiler.resources.map((r) => r.qvac_process_mb))); return v.length ? Math.max(...v) : null }
// QVAC worker memory samples grouped by which models were loaded when the sample was taken
const memoryByResident = (() => {
  const g = new Map()
  for (const s of steps) {
    for (const r of s.profiler.resources) {
      if (typeof r.qvac_process_mb !== 'number') continue
      const k = s.resident.length ? s.resident.join(' + ') : '(none)'
      const x = g.get(k) || { models_loaded: k, samples: 0, qvac_process_mb_max: 0, system_used_mb_max: 0 }
      x.samples++
      x.qvac_process_mb_max = Math.max(x.qvac_process_mb_max, r.qvac_process_mb)
      x.system_used_mb_max = Math.max(x.system_used_mb_max, r.system_used_mb ?? 0)
      g.set(k, x)
    }
  }
  return [...g.values()]
})()
const loadView = (ss) => ({
  each_server_handler_ms: ss.map((s) => rpcMs(s, 'loadModel', 'server.handlerExecution') ?? null),
  server_handler_ms: stat(ss.map((s) => rpcMs(s, 'loadModel', 'server.handlerExecution'))),
  client_total_ms: stat(ss.map((s) => rpcMs(s, 'loadModel', 'totalClientTime'))),
  handler_gauges: ss.flatMap((s) => handlers(s, 'loadModel').map((h) => h.gauges || null)).filter(Boolean)
})
const unloadView = (ss) => ({ handler_ms: stat(ss.flatMap((s) => handlers(s, 'unloadModel').map((h) => h.ms))), client_total_ms: stat(ss.map((s) => rpcMs(s, 'unloadModel', 'totalClientTime'))) })
const asrCalls = sel('asr', 'transcribe')
const asrStats = (ss, k) => stat(ss.map((s) => s.result?.sdk_stats?.[k]))
const llmCompletions = steps.filter((s) => s.capability === 'llm' && s.app_llm_stats?.length).flatMap((s) => {
  const hs = handlers(s, 'completionStream')
  if (hs.length !== s.app_llm_stats.length) s.attribution_warning = `${hs.length} completionStream profiler events for ${s.app_llm_stats.length} completions`
  // profiler: handler ms, ttfb, modelExecutionTime, stream chunk count. SDK completion stats (run.final.stats, kept by
  // src/llm.js): time to first token, tokens/s, prompt tokens computed vs served from the KV cache, generated tokens.
  return s.app_llm_stats.map((a, i) => ({
    step: s.seq, task: a.task, chars: s.input?.chars,
    profiler_ms: hs[i]?.ms, profiler_ttfb_ms: hs[i]?.gauges?.ttfb, profiler_model_execution_ms: hs[i]?.gauges?.modelExecutionTime, profiler_chunks: hs[i]?.count,
    app_wall_ms: a.ms,
    ttft_ms: hs[i]?.gauges?.timeToFirstToken ?? a.timeToFirstToken, tps: hs[i]?.gauges?.tokensPerSecond ?? a.tokensPerSecond,
    prompt_tokens_computed: a.promptTokens, cache_tokens: hs[i]?.gauges?.cacheTokens ?? a.cacheTokens,
    prompt_tokens_total: typeof a.promptTokens === 'number' && typeof a.cacheTokens === 'number' ? a.promptTokens + a.cacheTokens : null,
    generated_tokens: a.generatedTokens, prompt_tps: a.promptTokensPerSecond
  }))
})
const llmView = (cs) => ({
  calls: cs.length,
  completion_profiler_ms: stat(cs.map((c) => c.profiler_ms)),
  profiler_ttfb_ms: stat(cs.map((c) => c.profiler_ttfb_ms)),
  time_to_first_token_ms: stat(cs.map((c) => c.ttft_ms)),
  tokens_per_second: stat(cs.map((c) => c.tps)),
  prompt_tokens_per_second: stat(cs.map((c) => c.prompt_tps)),
  prompt_tokens_total: stat(cs.map((c) => c.prompt_tokens_total)),
  prompt_tokens_computed: stat(cs.map((c) => c.prompt_tokens_computed)),
  prompt_tokens_from_kv_cache: stat(cs.map((c) => c.cache_tokens)),
  generated_tokens: stat(cs.map((c) => c.generated_tokens)),
  input_chars: stat(cs.map((c) => c.chars))
})
const ocrReads = sel('ocr', 'read')
const ocrG = (k) => stat(ocrReads.flatMap((s) => handlers(s, 'ocrStream').map((h) => h.gauges?.[k])))
const vadRows = sel('vad', 'transcribe').map((s) => ({ vad: s.input.vad, clip: s.input.clip, audio_s: s.result?.audio_s ?? null, transcribe_ms: handlers(s, 'transcribe')[0]?.ms ?? null, rtf: s.result?.sdk_stats?.realTimeFactor ?? null, tokens: s.result?.sdk_stats?.totalTokens ?? null, text: s.result?.text ?? '', ...(s.result?.error ? { error: s.result.error } : {}) }))

const summary = {
  asr: {
    model: `${describeModel('asr').file} + ${describeModel('vad').file} (vadModelSrc)`,
    load: loadView(sel('asr', 'load')),
    language_switch: { ...loadView(sel('asr', 'switch')), handler_ms: stat(sel('asr', 'switch').flatMap((s) => handlers(s, 'loadModel').map((h) => h.ms))) },
    transcribe: {
      clips: asrCalls.length,
      audio_s: stat(asrCalls.map((s) => s.result.audio_s)),
      handler_ms: stat(asrCalls.flatMap((s) => handlers(s, 'transcribe').map((h) => h.ms))),
      ttfb_ms: stat(asrCalls.map((s) => rpcMs(s, 'transcribe', 'ttfb') ?? handlers(s, 'transcribe')[0]?.gauges?.ttfb)),
      wall_ms: stat(asrCalls.map((s) => s.wall_ms)),
      sdk_stats: Object.fromEntries(['realTimeFactor', 'tokensPerSecond', 'totalTokens', 'totalSegments', 'audioDuration', 'whisperEncodeTime', 'whisperDecodeTime', 'totalTime', 'totalWallMs', 'totalSamples', 'processCalls'].map((k) => [k, asrStats(asrCalls, k)]).filter(([, v]) => v)),
      warm_up_ms: sel('asr', 'warm-up')[0]?.profiler.handler.find((h) => h.op === 'transcribe')?.ms ?? null
    },
    unload: unloadView(sel('asr', 'unload')),
    peak_qvac_process_mb_sampled: peakMb('asr')
  },
  vad: {
    note: 'Silero VAD runs inside the Whisper transcribe() call (vadModelSrc); the SDK reports no separate VAD timing, so this compares the same clips with and without the VAD model.',
    load: { with_vad: loadView(sel('vad', 'load', (s) => s.input.vad)), without_vad: loadView(sel('vad', 'load', (s) => !s.input.vad)) },
    rows: vadRows
  },
  llm: {
    model: describeModel('llm').file,
    load: loadView(sel('llm', 'load')),
    prompt_cache_warm_up: { wall_ms: sel('llm', 'prompt-cache')[0]?.wall_ms ?? null, completion_profiler_ms: sel('llm', 'prompt-cache')[0]?.profiler.handler.filter((h) => h.op === 'completionStream').map((h) => h.ms) ?? [] },
    all: llmView(llmCompletions),
    intent: llmView(llmCompletions.filter((c) => c.task === 'intent')),
    scam_opinion: llmView(llmCompletions.filter((c) => c.task === 'scam')),
    unload: unloadView(sel('llm', 'unload')),
    peak_qvac_process_mb_sampled: peakMb('llm')
  },
  ocr: {
    model: `${describeModel('ocr').file} + ${describeModel('ocr_detector').file}`,
    load: loadView(sel('ocr', 'load')),
    read: {
      screenshots: ocrReads.length,
      handler_ms: stat(ocrReads.flatMap((s) => handlers(s, 'ocrStream').map((h) => h.ms))),
      model_execution_ms: ocrG('modelExecutionTime'),
      addon_detection_s: ocrG('detectionTime'),
      addon_recognition_s: ocrG('recognitionTime'),
      addon_total_s: ocrG('totalTime'),
      wall_ms: stat(ocrReads.map((s) => s.wall_ms))
    },
    unload: unloadView(sel('ocr', 'unload')),
    peak_qvac_process_mb_sampled: peakMb('ocr')
  },
  memory_by_models_loaded: memoryByResident
}

// What the profiler did NOT report for our calls (written from the events, not assumed)
const notes = []
if (!events.some((e) => e.op === 'loadModel' && e.kind === 'handler' && e.gauges?.totalLoadTime !== undefined)) notes.push('loadModel from a local file: no handler-level gauges (totalLoadTime, modelInitializationTime) were reported; load times are the RPC phases server.handlerExecution (inside the QVAC worker) and totalClientTime.')
if (!events.some((e) => e.op === 'transcribe' && e.kind === 'handler' && e.gauges && Object.keys(e.gauges).some((k) => k !== 'ttfb'))) notes.push('transcribe(): the profiler records time only (no token or real-time-factor gauges for this operation); those numbers come from the same call\'s own stats (transcribe().stats), recorded per clip as sdk_stats.')
if (!events.some((e) => e.op === 'completionStream' && e.gauges?.timeToFirstToken !== undefined)) notes.push('completion: the profiler event carries time, ttfb, modelExecutionTime and the stream chunk count, but no timeToFirstToken or tokensPerSecond gauge; those, and the prompt/cache/generated token counts, come from the same call\'s completion stats (completion().final.stats, kept by src/llm.js).')
const warn = steps.filter((s) => s.attribution_warning)
if (warn.length) notes.push(`attribution: ${warn.length} step(s) where profiler events and completions did not pair up: ${warn.map((s) => s.seq).join(', ')}`)
if (summary.ocr.read.addon_total_s) notes.push('ocr: the OCR addon reports detectionTime, recognitionTime and totalTime in SECONDS (they match modelExecutionTime / 1000); profiler.exportTable() prints them with an ms unit.')
if (summary.asr.transcribe.sdk_stats.totalTime) notes.push('transcribe().stats: totalTime is reported in SECONDS on this build (it equals totalWallMs / 1000), although the SDK schema describes it as ms; audioDuration, whisperEncodeTime and whisperDecodeTime are in ms.')
notes.push('OCR and transcription report no time to first token: they return one result per call (whisper reports its token count and tokens/s in transcribe().stats; OCR reports no tokens).')
{
  const conn = events.filter((e) => e.op === 'rpc' && e.phase === 'connection')
  notes.push(`rpc.connection: the SDK client connected to its QVAC worker ${conn.length} time(s) (${conn.map((e) => `${e.ms} ms, during step ${e.step ?? 'none'}`).join('; ')}).`)
}
notes.push('Memory: qvac_process_mb is the SDK resource gauge (processUsedBytes of the QVAC worker), sampled once per profiled operation, not a high-water mark. Hard peaks under a cgroup cap: README, "Runs in 3 GB".')

const cpu = os.cpus()
const cpuinfo = (() => { try { return readFileSync('/proc/cpuinfo', 'utf8') } catch { return '' } })()
const osRelease = (() => { try { return /^PRETTY_NAME="?([^"\n]*)"?/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? null } catch { return null } })()
const pkgVersion = (p) => { try { return JSON.parse(readFileSync(join(ROOT, 'node_modules', p, 'package.json'), 'utf8')).version } catch { return null } }
const doc = {
  what: 'QVAC SDK profiler export for one offline run of Sauti Pesa\'s AI code paths (speech to text + VAD, intent LLM, OCR). Produced by scripts/profile_qvac.sh; see evidence/README.md.',
  started_at: startedAt,
  run_wall_ms: runWallMs,
  sdk: { '@qvac/sdk': pkgVersion('@qvac/sdk'), '@qvac/inference': pkgVersion('@qvac/inference') },
  hardware: {
    cpu_model: cpu[0]?.model || null,
    cpu_count: cpu.length,
    cpu_implementer: /^CPU implementer\s*:\s*(\S+)/m.exec(cpuinfo)?.[1] ?? null,
    ram_total_mb: MB(os.totalmem()),
    os: osRelease,
    kernel: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    gpu: 'none used (CPU only; llm device: cpu)',
    qvac_getSystemResources: systemResources
  },
  sandbox: { mode: process.env.SAUTI_SANDBOX || 'none', network_before: netBefore, network_after: netAfter },
  models: ['asr', 'vad', 'llm', 'ocr', 'ocr_detector'].map(describeModel),
  app_config: { asr_threads: CFG.asr_threads, llm_threads: CFG.llm_threads || 'SDK default', llm_ctx_size: llm.ctxSize, ocr_threads: CFG.ocr_threads, ocr: { magRatio: 1.0, canvasSize: 1024 } },
  summary,
  notes,
  llm_completions: llmCompletions,
  steps,
  profiler: { config: exported.config, aggregates: exported.aggregates, exportedAt: exported.exportedAt, events_recorded: events.length, events },
  profiler_table: table.split('\n'),
  profiler_summary: summaryText.split('\n')
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n', { mode: 0o644 })

// a short readable digest on stdout
const f = (x) => (x ? `${x.median} (${x.min}-${x.max}, n=${x.n})` : 'n/a')
console.log(`wrote ${rel(OUT)}: ${steps.length} steps, ${events.length} profiler events, ${Math.round(runWallMs / 1000)} s, network during run: ${netBefore.online || netAfter.online ? 'ON' : 'off'}`)
console.log(`asr load ${f(summary.asr.load.server_handler_ms)} ms | transcribe ${f(summary.asr.transcribe.handler_ms)} ms | rtf ${f(summary.asr.transcribe.sdk_stats.realTimeFactor)} | tok/s ${f(summary.asr.transcribe.sdk_stats.tokensPerSecond)} | unload ${f(summary.asr.unload.handler_ms)} ms | peak ${summary.asr.peak_qvac_process_mb_sampled} MB`)
console.log(`llm load ${f(summary.llm.load.server_handler_ms)} ms | completion ${f(summary.llm.all.completion_profiler_ms)} ms | ttft ${f(summary.llm.all.time_to_first_token_ms)} ms | tok/s ${f(summary.llm.all.tokens_per_second)} | prompt computed ${f(summary.llm.all.prompt_tokens_computed)} cached ${f(summary.llm.all.prompt_tokens_from_kv_cache)} | unload ${f(summary.llm.unload.handler_ms)} ms | peak ${summary.llm.peak_qvac_process_mb_sampled} MB`)
console.log(`ocr load ${f(summary.ocr.load.server_handler_ms)} ms | read ${f(summary.ocr.read.model_execution_ms)} ms | unload ${f(summary.ocr.unload.handler_ms)} ms | peak ${summary.ocr.peak_qvac_process_mb_sampled} MB`)
for (const r of vadRows) console.log(`vad ${r.vad ? 'on ' : 'off'} ${r.clip.padEnd(24)} ${String(r.audio_s).padStart(5)} s  ${String(r.transcribe_ms).padStart(5)} ms  "${r.text.slice(0, 60)}"`)
for (const m of memoryByResident) console.log(`memory: ${m.models_loaded.padEnd(32)} QVAC worker up to ${m.qvac_process_mb_max} MB (${m.samples} samples)`)
for (const n of notes) console.log(`note: ${n}`)
