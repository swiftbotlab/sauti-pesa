// Local speech-to-text via QVAC (whisper.cpp engine + Silero VAD). Runs fully on device.
// Every clip first goes through input level normalization (src/gain.js): a quiet recording is raised with one linear
// gain before voice detection and speech to text; normal and loud recordings are passed on unchanged.
import { openSync, readSync, closeSync, statSync, fstatSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadModel, transcribe, unloadModel } from '@qvac/sdk'
import { clean } from './text.js'
import { normalizeWav } from './gain.js'

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024
export const MAX_AUDIO_SECONDS = 30

/** Check by CONTENT that a file is a PCM WAV we accept, and how long it is. */
export function inspectWav (path) {
  const st = statSync(path)
  if (!st.isFile()) throw new Error('audio is not a regular file')
  if (st.size > MAX_AUDIO_BYTES) throw new Error('audio file too large')
  const fd = openSync(path, 'r')
  const h = Buffer.alloc(Math.min(4096, st.size))
  try { readSync(fd, h, 0, h.length, 0) } finally { closeSync(fd) }
  if (h.toString('ascii', 0, 4) !== 'RIFF' || h.toString('ascii', 8, 12) !== 'WAVE') throw new Error('audio must be a WAV file (RIFF/WAVE)')
  let off = 12; let fmt = null; let dataBytes = null
  while (off + 8 <= h.length) {
    const id = h.toString('ascii', off, off + 4); const size = h.readUInt32LE(off + 4)
    if (id === 'fmt ') fmt = { format: h.readUInt16LE(off + 8), channels: h.readUInt16LE(off + 10), rate: h.readUInt32LE(off + 12), bits: h.readUInt16LE(off + 22) }
    if (id === 'data') { dataBytes = Math.min(size, st.size - off - 8); break }
    off += 8 + size + (size % 2)
  }
  if (!fmt || dataBytes === null) throw new Error('WAV header is incomplete')
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.channels > 2 || fmt.rate < 8000 || fmt.rate > 48000) throw new Error('WAV must be 16-bit PCM, mono or stereo, 8-48 kHz')
  const seconds = dataBytes / (fmt.rate * fmt.channels * 2)
  if (seconds > MAX_AUDIO_SECONDS) throw new Error(`audio longer than ${MAX_AUDIO_SECONDS} s`)
  return { ...fmt, seconds }
}

/**
 * Level-normalize a WAV (already checked by inspectWav) for speech to text.
 * Unchanged clips: the original path. Raised clips: a NEW file in tmpDir (mode 0600, created exclusively, random
 * name) that the caller removes with cleanup(). The original file is never modified.
 * @returns {{ path: string, info: object, cleanup: () => void }}
 */
export function levelAudio (wavPath, tmpDir = tmpdir()) {
  const { buf, info } = normalizeWav(readCapped(wavPath, MAX_AUDIO_BYTES))
  if (!buf) return { path: wavPath, info, cleanup () {} }
  const dir = realpathSync(tmpDir)
  if (!statSync(dir).isDirectory()) throw new Error('audio temp dir is not a directory')
  const p = join(dir, `level-${randomUUID()}.wav`) // .wav: QVAC decodes it exactly like the original file
  writeFileSync(p, buf, { mode: 0o600, flag: 'wx' })
  return { path: p, info, cleanup () { rmSync(p, { force: true }) } }
}

// read at most `max` bytes; a file that grew past the cap since inspectWav is refused, not truncated
function readCapped (path, max) {
  const fd = openSync(path, 'r')
  try {
    if (!fstatSync(fd).isFile()) throw new Error('audio is not a regular file')
    const b = Buffer.alloc(max + 1)
    let n = 0; let r
    while (n < b.length && (r = readSync(fd, b, n, b.length - n, n)) > 0) n += r
    if (n > max) throw new Error('audio file too large')
    return b.subarray(0, n)
  } finally { closeSync(fd) }
}

// Short, human labels for the Whisper files the app can use (UI steps, status, CLI output)
const ASR_LABELS = {
  'ggml-whisper-swahili-small-q8_0.bin': 'Swahili Whisper small q8_0 (fine-tune)',
  'ggml-small-q8_0.bin': 'whisper small q8_0',
  'ggml-large-v3-turbo-q5_0.bin': 'whisper large-v3-turbo q5_0',
  'ggml-base-q8_0.bin': 'whisper base q8_0'
}
export function asrLabel (file) { return ASR_LABELS[basename(String(file || ''))] || basename(String(file || '')) }

// The Swahili fine-tune writes lower case without punctuation and spells the token "ust" ("tuma ust hamsini").
// Only these whole words become "USDT" again, so the transcript the person sees and the amount checks (which look
// for "USDT 20" / "20 USDT") read it as said. Nothing else in the transcript is changed.
const TOKEN_WORD = /(?<![\p{L}\p{N}_])(?:ust|usdt)(?![\p{L}\p{N}_])/giu
export function normalizeTokenWords (text) { return String(text).replace(TOKEN_WORD, 'USDT') }

const PROMPTS = {
  sw: (names) => `Tuma USDT kumi na tano kwa ${names[0] || 'Amina'}. Mtumie kaka yangu USDT mia moja. ${names.join(', ')}.`,
  en: (names) => `Send 15 USDT to ${names[0] || 'Amina'}. ${names.join(', ')}.`,
  auto: (names) => `USDT, ${names.join(', ')}.`
}

export class LocalASR {
  /**
   * @param {object} o
   * @param {string} o.modelPath the Whisper file for every language without its own entry in modelPaths
   * @param {Object<string,string>} [o.modelPaths] per-language Whisper files, e.g. { sw: <Swahili fine-tune> }. In
   *   single mode a language with a DIFFERENT file unloads the current instance first and loads that file, so
   *   there is still only one Whisper in RAM; a language with the same file only reloads its config.
   * @param {boolean} [o.single] keep ONE whisper instance and switch its language with QVAC's reload-config
   *   (loadModel({ modelId, modelConfig })) instead of loading one instance per language: about half the RAM
   *   for the resident engine. The CLI keeps the old behaviour.
   * @param {string} [o.tmpDir] where a level-raised copy of a quiet clip is written for a moment (default: TMPDIR)
   * @param {boolean} [o.inputGain] level normalization before VAD/ASR (default on; off only to measure without it)
   */
  constructor ({ modelPath, modelPaths = {}, vadPath, threads = 4, audioCtx = 0, names = [], single = false, tmpDir = null, inputGain = true }) {
    Object.assign(this, { modelPath, vadPath, threads, audioCtx, single, tmpDir, inputGain })
    this.modelPaths = {}
    for (const [l, f] of Object.entries(modelPaths || {})) if (['sw', 'en'].includes(l) && typeof f === 'string' && f) this.modelPaths[l] = f
    this.names = names.map((n) => clean(n, 40)).filter(Boolean).slice(0, 12)
    this.models = new Map()
    this.loadMs = {}
    this.current = null // single mode: { id, lang, path }
    this.switchMs = [] // same file, other language: reload-config
    this.swapMs = [] // other file: unload + load
  }

  /** The Whisper file used for a language. */
  pathFor (lang) { return this.modelPaths[lang] || this.modelPath }

  _config (lang) {
    return {
      language: lang,
      vadModelSrc: this.vadPath,
      n_threads: this.threads,
      ...(this.audioCtx ? { audio_ctx: this.audioCtx } : {}),
      strategy: 'greedy',
      temperature: 0.0,
      suppress_nst: true,
      no_timestamps: true,
      initial_prompt: (PROMPTS[lang] || PROMPTS.auto)(this.names)
    }
  }

  async _model (lang) {
    const path = this.pathFor(lang)
    if (this.single) {
      if (this.current?.lang === lang) return this.current.id
      const t = Date.now()
      if (this.current && this.current.path === path) {
        await loadModel({ modelId: this.current.id, modelType: 'whispercpp-transcription', modelConfig: this._config(lang) })
        this.current = { id: this.current.id, lang, path }
        this.switchMs.push(Date.now() - t)
        return this.current.id
      }
      const swap = !!this.current
      if (swap) { const old = this.current.id; this.current = null; await unloadModel({ modelId: old }) } // never two Whispers in RAM
      const id = await loadModel({ modelSrc: path, modelType: 'whispercpp-transcription', modelConfig: this._config(lang) })
      this.current = { id, lang, path }
      if (swap) this.swapMs.push(Date.now() - t); else this.loadMs[lang] = Date.now() - t
      return id
    }
    if (this.models.has(lang)) return this.models.get(lang)
    const t = Date.now()
    const id = await loadModel({ modelSrc: path, modelType: 'whispercpp-transcription', modelConfig: this._config(lang) })
    this.loadMs[lang] = Date.now() - t
    this.models.set(lang, id)
    return id
  }

  /** Load (or switch to) a language ahead of the first request. */
  async prepare (lang = 'sw') { await this._model(lang) }

  /**
   * @returns {Promise<{text:string, ms:number, lang:string, seconds:number, gain:object, model:string}>} gain: the
   *   input level step ({ rms_dbfs, peak_dbfs, gain_db, applied, reason }, or { applied: false, reason: 'off' });
   *   model: the file name of the Whisper weights that heard it
   */
  async transcribe (wavPath, lang = 'sw') {
    if (!['sw', 'en', 'auto'].includes(lang)) throw new Error('lang must be sw, en or auto')
    const info = inspectWav(wavPath)
    const lv = this.inputGain ? levelAudio(wavPath, this.tmpDir || tmpdir()) : { path: wavPath, info: { applied: false, gain_db: 0, reason: 'off' }, cleanup () {} }
    try {
      const id = await this._model(lang)
      const t = Date.now()
      const text = await transcribe({ modelId: id, audioChunk: lv.path })
      return { text: normalizeTokenWords(clean(String(text), 1000)), ms: Date.now() - t, lang, seconds: +info.seconds.toFixed(2), gain: lv.info, model: basename(this.pathFor(lang)) }
    } finally {
      lv.cleanup()
    }
  }

  async unload () {
    for (const id of this.models.values()) await unloadModel({ modelId: id })
    this.models.clear()
    if (this.current) await unloadModel({ modelId: this.current.id })
    this.current = null
  }
}
