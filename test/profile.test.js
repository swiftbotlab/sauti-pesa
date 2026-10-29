// Model profiles (src/profile.js): the default stays exactly config.json; lite swaps only the language model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileName, applyProfile, loadConfig, llmLabel, PROFILES } from '../src/profile.js'
import { childEnvFrom } from '../src/launch_env.js'
import { modelKeyFor, missingModelMessage } from '../src/setup_hint.js'
import { entryFor, DEFAULT_KEYS, LITE_KEYS } from '../scripts/fetch_models.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RAW = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const MODELS = JSON.parse(readFileSync(join(ROOT, 'models.json'), 'utf8'))

test('profile: unset or empty is the default, and the default is config.json unchanged', () => {
  assert.equal(profileName({}), 'default')
  assert.equal(profileName({ SAUTI_PROFILE: '' }), 'default')
  const c = loadConfig(ROOT, {})
  assert.equal(c.profile, 'default')
  assert.deepEqual(c.models, RAW.models)
  assert.equal(c.models.llm, 'models/Qwen3-1.7B-Q4_0.gguf')
  assert.equal(modelKeyFor(ROOT, c.models.llm), 'QWEN3_1_7B_INST_Q4')
})

test('profile: lite swaps only the language model (Qwen3-0.6B); speech, VAD and OCR stay the same files', () => {
  const c = loadConfig(ROOT, { SAUTI_PROFILE: 'lite' })
  assert.equal(c.profile, 'lite')
  assert.equal(c.models.llm, 'models/Qwen3-0.6B-Q4_0.gguf')
  assert.equal(modelKeyFor(ROOT, c.models.llm), 'QWEN3_600M_INST_Q4')
  for (const k of Object.keys(RAW.models).filter((x) => x !== 'llm')) assert.equal(c.models[k], RAW.models[k], k)
  assert.equal(c.network, RAW.network)
  assert.deepEqual(c.limits, RAW.limits)
  assert.equal(RAW.models.llm, 'models/Qwen3-1.7B-Q4_0.gguf', 'loading lite does not change the parsed default')
  assert.match(missingModelMessage(ROOT, c.models.llm, {}), /scripts\/fetch_models\.sh QWEN3_600M_INST_Q4/)
})

test('profile: unknown names and bad overrides are refused', () => {
  for (const v of ['LITE', 'lite ', 'full', '../lite', 'lite;rm']) assert.throws(() => profileName({ SAUTI_PROFILE: v }), /SAUTI_PROFILE must be one of/)
  assert.throws(() => applyProfile(RAW, 'nope'), /unknown profile/)
  assert.throws(() => applyProfile({ models: RAW.models }, 'lite'), /no profiles\.lite\.models/)
  assert.throws(() => applyProfile({ models: RAW.models, profiles: { lite: { models: { llm: '/etc/passwd' } } } }, 'lite'), /must be models\/<file>/)
  assert.throws(() => applyProfile({ models: RAW.models, profiles: { lite: { models: { llm: 'models/../private/wallet.json' } } } }, 'lite'), /must be models\/<file>/)
  assert.throws(() => applyProfile({ models: RAW.models, profiles: { lite: { models: { wallet: 'models/x.gguf' } } } }, 'lite'), /not a model slot/)
  assert.deepEqual(PROFILES, ['default', 'lite'])
})

test('profile: the lite model is pinned like the others (QVAC constant, https origin at a commit, size + sha256)', () => {
  const e = entryFor(MODELS, 'QWEN3_600M_INST_Q4')
  assert.equal(e.qvac_constant, 'QWEN3_600M_INST_Q4')
  assert.equal(e.engine, 'llamacpp-completion')
  assert.equal(e.bytes, 382156480)
  assert.equal(e.sha256, '33bcc57074ec7b6eada5a90651ee546ec0c2b271002c22baf9f1b2dd1e8f75cb')
  assert.match(e.url, /^https:\/\/huggingface\.co\/unsloth\/Qwen3-0\.6B-GGUF\/resolve\/[0-9a-f]{40}\/Qwen3-0\.6B-Q4_0\.gguf$/)
  assert.equal(join('models', e.file), loadConfig(ROOT, { SAUTI_PROFILE: 'lite' }).models.llm)
  try { assert.equal(statSync(join(ROOT, 'models', e.file)).size, e.bytes) } catch (err) { if (err.code !== 'ENOENT') throw err }
  assert.deepEqual(LITE_KEYS.filter((k) => k !== 'QWEN3_600M_INST_Q4'), DEFAULT_KEYS.filter((k) => k !== 'QWEN3_1_7B_INST_Q4'))
  for (const k of LITE_KEYS) entryFor(MODELS, k)
})

test('profile: the portable launcher passes only a known profile name to its children', () => {
  const base = { home: '/h', tmp: '/t' }
  assert.equal(childEnvFrom({ SAUTI_PROFILE: 'lite' }, base).SAUTI_PROFILE, undefined, 'never copied from the caller')
  assert.equal(childEnvFrom({}, { ...base, extra: { SAUTI_PROFILE: 'lite' } }).SAUTI_PROFILE, 'lite')
  assert.equal(childEnvFrom({}, { ...base, extra: { SAUTI_PROFILE: 'default' } }).SAUTI_PROFILE, undefined)
  assert.equal(childEnvFrom({}, { ...base, extra: { SAUTI_PROFILE: 'lite;x' } }).SAUTI_PROFILE, undefined)
})

test('profile: display names of the language models', () => {
  assert.equal(llmLabel('models/Qwen3-1.7B-Q4_0.gguf'), 'Qwen3-1.7B Q4_0')
  assert.equal(llmLabel('models/Qwen3-0.6B-Q4_0.gguf'), 'Qwen3-0.6B Q4_0')
  assert.equal(llmLabel('models/Qwen3.5-2B-Q4_K_M.gguf'), 'Qwen3.5-2B Q4_K_M')
  assert.equal(llmLabel('models/plain.gguf'), 'plain')
})
