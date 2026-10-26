// Print registry model constants of interest (runs in the offline sandbox; registry data only).
const m = await import('../node_modules/@qvac/inference/dist/models/registry/models.js')
const want = new RegExp(process.argv[2] || 'WHISPER|QWEN|LLAMA|GEMMA|PHI|SMOL|SILERO|VAD|AFRI|SWAHILI|PARAKEET_TDT', 'i')
for (const [k, v] of Object.entries(m)) {
  if (!v || typeof v !== 'object' || !v.registryPath || !want.test(k)) continue
  console.log(JSON.stringify({ k, src: v.registrySource, path: v.registryPath, mb: Math.round(v.expectedSize / 1e6), engine: v.engine, q: v.quantization, sha: (v.sha256Checksum || '').slice(0, 12) }))
}
