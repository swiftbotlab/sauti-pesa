// Dump full registry entries for chosen constants (offline sandbox; data only).
const m = await import('../node_modules/@qvac/inference/dist/models/registry/models.js')
const out = {}
for (const k of process.argv.slice(2)) {
  const v = m[k]
  if (!v) { console.error('missing', k); continue }
  out[k] = { registrySource: v.registrySource, registryPath: v.registryPath, expectedSize: v.expectedSize, sha256: v.sha256Checksum, engine: v.engine, addon: v.addon, quantization: v.quantization, params: v.params, modelId: v.modelId }
}
console.log(JSON.stringify(out, null, 1))
