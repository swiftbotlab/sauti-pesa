// Per-language speech models (src/asr.js): Swahili uses the Swahili fine-tune of Whisper small when it is on disk,
// English the multilingual Whisper small. No model is loaded here; the swap itself is exercised by test/e2e_ui.sh
// (an English voice note between two Swahili ones) and scripts/bench_e2e.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LocalASR, asrLabel, normalizeTokenWords } from '../src/asr.js'

const ROOT = new URL('..', import.meta.url).pathname
const CFG = JSON.parse(readFileSync(`${ROOT}config.json`, 'utf8'))
const MODELS = JSON.parse(readFileSync(`${ROOT}models.json`, 'utf8'))

test('pathFor: Swahili gets its own file, every other language the default one', () => {
  const a = new LocalASR({ modelPath: '/m/generic.bin', modelPaths: { sw: '/m/sw.bin' }, vadPath: '/m/vad.bin', single: true })
  assert.equal(a.pathFor('sw'), '/m/sw.bin')
  assert.equal(a.pathFor('en'), '/m/generic.bin')
  assert.equal(a.pathFor('auto'), '/m/generic.bin')
  const b = new LocalASR({ modelPath: '/m/generic.bin', vadPath: '/m/vad.bin' })
  assert.equal(b.pathFor('sw'), '/m/generic.bin', 'no Swahili file given: the default one')
})

test('modelPaths accepts only known languages and non-empty strings', () => {
  const a = new LocalASR({ modelPath: '/m/g.bin', modelPaths: { xx: '/m/x.bin', auto: '/m/a.bin', en: '', sw: 42 }, vadPath: '/m/v.bin' })
  assert.deepEqual(a.modelPaths, {})
  assert.equal(a.pathFor('en'), '/m/g.bin')
})

test('"ust"/"usdt" as whole words become USDT; nothing else changes', () => {
  assert.equal(normalizeTokenWords('tuma ust hamsini kwa juma'), 'tuma USDT hamsini kwa juma')
  assert.equal(normalizeTokenWords('Tuma USDT 20 kwa Amina'), 'Tuma USDT 20 kwa Amina')
  assert.equal(normalizeTokenWords('kwa ust. asante'), 'kwa USDT. asante')
  for (const s of ['trust me', 'ustawi wa jamii', 'usdt0', 'mkristo', 'just', 'tuma usid tano']) assert.equal(normalizeTokenWords(s), s)
})

test('labels for the Whisper files the app ships', () => {
  assert.equal(asrLabel('models/ggml-whisper-swahili-small-q8_0.bin'), 'Swahili Whisper small q8_0 (fine-tune)')
  assert.equal(asrLabel('/x/ggml-small-q8_0.bin'), 'whisper small q8_0')
  assert.equal(asrLabel('other.bin'), 'other.bin')
})

test('config: the Swahili model is pinned in models.json (commit, sha256, size, licence)', () => {
  const rel = CFG.models.asr_sw
  assert.equal(rel, 'models/ggml-whisper-swahili-small-q8_0.bin')
  const e = MODELS.WHISPER_SMALL_SW_Q8_0
  assert.equal(`models/${e.file}`, rel)
  assert.match(e.url, /^https:\/\/huggingface\.co\/malinali-app\/whisper-swahili-small-ggml\/resolve\/403b03e660aa3635823c42e4589c57a9b2c26fe5\/ggml-model-q8_0\.bin$/)
  assert.equal(e.sha256, '5d89c6ee07592a0c43fa560d592949635e7154cd716debda8d40919a772381a6')
  assert.equal(e.bytes, 264464624)
  assert.equal(e.engine, 'whispercpp-transcription')
  assert.match(e.license, /^Apache-2\.0/)
  // English stays on the multilingual model (the fine-tune hurts English: "send 40 USDT to" -> "send for usdt tu")
  assert.equal(CFG.models.asr, `models/${MODELS.WHISPER_SMALL_Q8_0.file}`)
})
