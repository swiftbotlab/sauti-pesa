// Speech to text on REAL human Swahili voices: Google FLEURS, Swahili (Kenya) test split, read speech by native
// speakers (CC-BY 4.0). Run by scripts/eval_fleurs_asr.sh, inside the offline sandbox:
//   ops/sandbox.sh offline node scripts/eval_fleurs_asr.mjs tmp/fleurs small|turbo
// It uses the app's own speech code, src/asr.js LocalASR, with the app's settings: config.json models, VAD, threads,
// language 'sw', greedy, temperature 0, and the demo contacts' names in the initial prompt (as the engine does).
//   small = what the app ships and the resident engine uses (config.models.asr)
//   turbo = the CLI's optional `say --accurate` model (config.models.asr_accurate + asr_accurate_audio_ctx)
// Scores the RAW transcript (before the app turns number words into digits) against the FLEURS `transcription`
// column with the small normalizer in scripts/asr_score.mjs. Writes DIR/results_<model>.json.
// The clip list (DIR/selected.json, made by scripts/fleurs_prepare.py) is data: every field is checked here again.
import { readFileSync, writeFileSync, renameSync, realpathSync, lstatSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { cpus, arch, totalmem, platform } from 'node:os'
import { close } from '@qvac/sdk'
import { LocalASR } from '../src/asr.js'
import { peakRssMb } from '../src/procmem.js'
import { score, normalize, median, percentile } from './asr_score.mjs'

const ROOT = realpathSync(new URL('..', import.meta.url).pathname)
const DIR = resolve(ROOT, process.argv[2] || 'tmp/fleurs')
const WHICH = process.argv[3] || 'small'
if (!DIR.startsWith(join(ROOT, 'tmp') + '/')) throw new Error('DIR must be under tmp/')
if (!['small', 'turbo'].includes(WHICH)) throw new Error('model must be small or turbo')

const CFG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const MODELS = JSON.parse(readFileSync(join(ROOT, 'models.json'), 'utf8'))
const rel = WHICH === 'small' ? CFG.models.asr : CFG.models.asr_accurate
const audioCtx = WHICH === 'small' ? 0 : (CFG.asr_accurate_audio_ctx || 0)
const modelFile = realpathSync(join(ROOT, rel))
const entry = Object.entries(MODELS).find(([, m]) => m.file === basename(rel))
if (!entry) throw new Error(`${rel} is not in models.json`)
if (statSync(modelFile).size !== entry[1].bytes) throw new Error(`${rel}: size differs from models.json`)
const names = JSON.parse(readFileSync(join(ROOT, 'data/demo-contacts.json'), 'utf8')).map((c) => c.name)

// ---- clip list (untrusted origin: re-validate)
const sel = JSON.parse(readFileSync(join(DIR, 'selected.json'), 'utf8'))
if (!Array.isArray(sel.clips) || sel.clips.length < 1 || sel.clips.length > 400) throw new Error('bad clip list')
const CLIPS = join(DIR, 'clips')
const clips = sel.clips.map((c) => {
  if (!/^[0-9]{1,25}\.wav$/.test(String(c.file))) throw new Error('bad clip file name')
  if (typeof c.transcription !== 'string' || c.transcription.length > 2000) throw new Error('bad reference')
  const p = join(CLIPS, c.file)
  if (lstatSync(p).isSymbolicLink() || realpathSync(p) !== p) throw new Error(`${c.file}: not a plain file in clips/`)
  return { id: Number(c.id), file: c.file, gender: String(c.gender).slice(0, 8), ref: c.transcription, path: p }
})

const asr = new LocalASR({
  modelPath: modelFile,
  vadPath: realpathSync(join(ROOT, CFG.models.vad)),
  threads: CFG.asr_threads || 4,
  audioCtx,
  names,
  single: WHICH === 'small' // the resident engine keeps one instance; the CLI path is the same for one language
})

const t0 = Date.now()
await asr.prepare('sw')
const loadMs = Date.now() - t0
// the engine warms the speech path once with config.asr_warmup before the first voice note; do the same
let warmupMs = null
if (typeof CFG.asr_warmup === 'string') {
  const w = Date.now(); await asr.transcribe(join(ROOT, CFG.asr_warmup), 'sw'); warmupMs = Date.now() - w
}

const nameToks = new Set(['usdt', ...names.flatMap((n) => normalize(n).split(' '))])
// loudness of the clip as the app receives it (RMS, dBFS). The clips are written by fleurs_prepare.py with a
// 44-byte header followed by 16-bit PCM samples.
function rmsDbfs (path) {
  const b = readFileSync(path)
  let acc = 0; let n = 0
  for (let o = 44; o + 1 < b.length; o += 2) { const x = b.readInt16LE(o); acc += x * x; n++ }
  return n ? +(20 * Math.log10(Math.sqrt(acc / n) / 32768 + 1e-12)).toFixed(1) : null
}
const out = []
for (const c of clips) {
  let r; let error = null
  try { r = await asr.transcribe(c.path, 'sw') } catch (e) { error = String(e.message).slice(0, 120) }
  const hyp = r ? r.text : ''
  const s = score(c.ref, hyp)
  const refToks = new Set(normalize(c.ref).split(' '))
  const leaked = normalize(hyp).split(' ').filter((t) => t && nameToks.has(t) && !refToks.has(t))
  const row = {
    id: c.id, file: c.file, gender: c.gender, rms_dbfs: rmsDbfs(c.path),
    audio_s: r ? r.seconds : null, asr_ms: r ? r.ms : null, rtf: r ? +(r.ms / 1000 / r.seconds).toFixed(3) : null,
    wer: +s.wer.toFixed(4), cer: +s.cer.toFixed(4),
    ref_words: s.ref_words, sub: s.sub, del: s.del, ins: s.ins, ref_chars: s.ref_chars, char_errors: s.char_errors,
    prompt_words_in_output: leaked,
    ref: c.ref, hyp, ...(error ? { error } : {})
  }
  out.push(row)
  console.error(`${row.id} ${row.audio_s}s ${row.asr_ms}ms WER ${row.wer} CER ${row.cer}${error ? ' ERROR ' + error : ''}`)
}
await asr.unload()
const rss = peakRssMb()
await close()

const ok = out.filter((r) => !r.error)
const sum = (k) => out.reduce((a, r) => a + (r[k] || 0), 0)
const lat = ok.map((r) => r.asr_ms)
const r3 = (x) => (x === null ? null : +x.toFixed(3))
const summary = {
  clips: out.length,
  errors: out.length - ok.length,
  audio_s_total: +ok.reduce((a, r) => a + r.audio_s, 0).toFixed(1),
  ref_words: sum('ref_words'),
  wer: r3((sum('sub') + sum('del') + sum('ins')) / sum('ref_words')),
  cer: r3(sum('char_errors') / sum('ref_chars')),
  wer_breakdown: { substitutions: sum('sub'), deletions: sum('del'), insertions: sum('ins') },
  median_clip_wer: r3(median(out.map((r) => r.wer))),
  median_clip_cer: r3(median(out.map((r) => r.cer))),
  clips_with_wer_0: out.filter((r) => r.wer === 0).length,
  clips_with_wer_over_0_5: out.filter((r) => r.wer > 0.5).length,
  clips_with_prompt_words_in_output: out.filter((r) => r.prompt_words_in_output.length).length,
  latency_ms: { median: median(lat), mean: Math.round(lat.reduce((a, x) => a + x, 0) / (lat.length || 1)), p90: percentile(lat, 90), min: Math.min(...lat), max: Math.max(...lat) },
  median_rtf: r3(median(ok.map((r) => r.rtf))),
  model_load_ms: loadMs,
  warmup_ms: warmupMs,
  peak_rss_mb: rss
}
// Secondary views of the SAME run (the headline is the full set above), so a reader can see where errors come from.
const corpus = (rows) => {
  const e = rows.reduce((a, r) => a + r.sub + r.del + r.ins, 0); const w = rows.reduce((a, r) => a + r.ref_words, 0)
  const ce = rows.reduce((a, r) => a + r.char_errors, 0); const cc = rows.reduce((a, r) => a + r.ref_chars, 0)
  return { clips: rows.length, wer: r3(w ? e / w : null), cer: r3(cc ? ce / cc : null), median_clip_wer: r3(median(rows.map((r) => r.wer))), median_clip_cer: r3(median(rows.map((r) => r.cer))) }
}
const QUIET_DBFS = -60
summary.subsets = {
  up_to_15_4_s: { note: 'clips up to 15.36 s (= audio_ctx 768, the --accurate setting; voice notes are usually shorter)', ...corpus(out.filter((r) => r.audio_s !== null && r.audio_s <= 15.36)) },
  over_15_4_s: corpus(out.filter((r) => r.audio_s !== null && r.audio_s > 15.36)),
  without_very_quiet_recordings: { note: `drops clips quieter than ${QUIET_DBFS} dBFS RMS (the app applies no gain)`, dropped_ids: out.filter((r) => r.rms_dbfs < QUIET_DBFS).map((r) => r.id), ...corpus(out.filter((r) => !(r.rms_dbfs < QUIET_DBFS))) },
  empty_transcripts: out.filter((r) => !r.hyp).map((r) => ({ id: r.id, rms_dbfs: r.rms_dbfs }))
}
const worst = [...out].sort((a, b) => b.wer - a.wer || b.cer - a.cer).slice(0, 3).map(({ id, file, audio_s, wer, cer, ref, hyp }) => ({ id, file, audio_s, wer, cer, ref, hyp }))

const result = {
  run: { model: WHICH, at: new Date().toISOString() },
  asr: {
    path: 'src/asr.js LocalASR.transcribe (the app\'s own speech-to-text code), offline sandbox',
    model_file: rel,
    model_key: entry[0],
    model_sha256: entry[1].sha256,
    vad: CFG.models.vad,
    language: 'sw',
    threads: CFG.asr_threads || 4,
    audio_ctx: audioCtx || 'default',
    decoding: 'greedy, temperature 0, suppress_nst, no_timestamps',
    initial_prompt: 'the app\'s Swahili prompt with the demo contacts\' names (data/demo-contacts.json)',
    scored_text: 'raw transcript from LocalASR.transcribe, before the app\'s number-word normalization'
  },
  device: { platform: platform(), arch: arch(), cpus: cpus().length, ram_gb: +(totalmem() / 2 ** 30).toFixed(1), gpu: false },
  summary,
  worst_3_by_wer: worst,
  clips: out
}
const dst = join(DIR, `results_${WHICH}.json`)
writeFileSync(dst + '.tmp', JSON.stringify(result, null, 1) + '\n')
renameSync(dst + '.tmp', dst)
console.log(JSON.stringify({ model: WHICH, ...summary }))
if (summary.errors) { console.error(`${summary.errors} clip(s) failed: the run is not valid`); process.exitCode = 1 }
