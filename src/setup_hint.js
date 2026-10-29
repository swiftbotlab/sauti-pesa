// The exact one-time download command for a missing model file, for the mode we run in. Models are only ever loaded
// from local files (never by registry name or URL), so a missing file is an error with this command, never a fetch.
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

/** models.json key whose file name is the file of `rel` (e.g. models/ggml-small-q8_0.bin -> WHISPER_SMALL_Q8_0). */
export function modelKeyFor (root, rel) {
  try {
    const m = JSON.parse(readFileSync(join(root, 'models.json'), 'utf8'))
    return Object.keys(m).find((k) => m[k]?.file === basename(String(rel))) || null
  } catch { return null }
}

/** The download command (run once, with the internet on) for these models.json keys. */
export function fetchCommand (keys, env = process.env) {
  const list = keys.filter(Boolean).join(' ') || '<MODEL_KEY>'
  return env.SAUTI_SANDBOX === 'portable' ? `npm run fetch-models -- ${list}` : `scripts/fetch_models.sh ${list}`
}

export function missingModelMessage (root, rel, env = process.env) {
  return `model missing: ${rel} (download it once, with the internet on: ${fetchCommand([modelKeyFor(root, rel)], env)})`
}
