// Model profiles. Node built-ins only (the portable launcher loads this before any third-party package).
// - default: config.json "models" exactly as it is (Qwen3-1.7B for intent and messages).
// - lite ("phone-class"): SAUTI_PROFILE=lite. Replaces only the files listed in config.json "profiles.lite.models":
//   the intent/message model becomes Qwen3-0.6B (QVAC's QWEN3_600M_INST_Q4, 382 MB instead of 1.06 GB). Speech to
//   text (Whisper small and its Swahili fine-tune), VAD and OCR stay the same files. The code checks that decide
//   are the same in both profiles. What lite costs and saves is measured, not assumed: evidence/lite-profile.json.
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

export const PROFILES = Object.freeze(['default', 'lite'])
const MODEL_REL = /^models\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

/** The profile asked for in the environment: unset or empty = default; anything unknown is refused. */
export function profileName (env = process.env) {
  const v = env.SAUTI_PROFILE
  if (v === undefined || v === '') return 'default'
  if (!PROFILES.includes(v)) throw new Error(`SAUTI_PROFILE must be one of: ${PROFILES.join(', ')} (got "${String(v).slice(0, 20)}")`)
  return v
}

/** config.json content -> the effective config for one profile (pure; never changes `cfg`). */
export function applyProfile (cfg, name) {
  if (!PROFILES.includes(name)) throw new Error(`unknown profile "${String(name).slice(0, 20)}"`)
  if (name === 'default') return { ...cfg, profile: 'default' }
  const over = cfg?.profiles?.[name]?.models
  if (!over || typeof over !== 'object' || Array.isArray(over) || !Object.keys(over).length) throw new Error(`config.json has no profiles.${name}.models`)
  for (const [k, v] of Object.entries(over)) {
    if (!Object.hasOwn(cfg.models || {}, k)) throw new Error(`profiles.${name}.models.${k}: not a model slot of config.json models`)
    if (typeof v !== 'string' || !MODEL_REL.test(v) || v.includes('..')) throw new Error(`profiles.${name}.models.${k}: must be models/<file>`)
  }
  return { ...cfg, profile: name, models: { ...cfg.models, ...over } }
}

/** Read config.json under `root` and apply the profile from `env` (SAUTI_PROFILE). */
export function loadConfig (root, env = process.env) {
  const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
  return applyProfile(cfg, profileName(env))
}

/** Short display name of a GGUF language model file: models/Qwen3-1.7B-Q4_0.gguf -> "Qwen3-1.7B Q4_0". */
export function llmLabel (rel) {
  const b = basename(String(rel || '')).replace(/\.gguf$/i, '')
  const m = b.match(/^(.+?)-((?:Q|IQ|BF|F)\d\w*)$/i)
  return m ? `${m[1]} ${m[2]}` : b
}
