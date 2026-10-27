// What QVAC itself says about this device and our models: getSystemResources() and the advisory assessModelFit()
// of @qvac/sdk 0.22.0 (nothing is downloaded, loaded or reserved). Offline sandbox; prints JSON lines:
//   ops/sandbox.sh offline node scripts/system_fit.mjs
//   scripts/fetch_registry_model.sh --fit          (the same, with registry access for the native fitter)
// Note: the SDK reads system memory; it does not look at cgroup limits, so under a memory cap it still reports the
// whole machine.
import { assessModelFit, close, getSystemResources, OCR_LATIN, QWEN3_1_7B_INST_Q4, WHISPER_SMALL_Q8_0 } from '@qvac/sdk'

const gib = (b) => (typeof b === 'number' ? +(b / 1024 ** 3).toFixed(2) : null)
const res = await getSystemResources({ sample: true })
console.log(JSON.stringify({ getSystemResources: res }, null, 0).slice(0, 4000))
const loads = [
  { modelSrc: QWEN3_1_7B_INST_Q4, modelType: 'llamacpp-completion', modelConfig: { ctx_size: 2048 } },
  { modelSrc: WHISPER_SMALL_Q8_0, modelType: 'whispercpp-transcription' },
  { modelSrc: OCR_LATIN, modelType: 'ggml-ocr' }
]
for (const execution of ['sequential', 'concurrent']) {
  try {
    const r = await assessModelFit({ models: loads, execution, policy: 'interactive-v1' })
    console.log(JSON.stringify({
      assessModelFit: execution,
      verdict: r.verdict,
      basis: r.basis,
      budget_gib: r.budget && { total: gib(r.budget.totalBytes), available: gib(r.budget.availableBytes), afterReserve: gib(r.budget.availableAfterReserveBytes) },
      models: r.models.map((m) => ({ name: m.name, verdict: m.verdict, evidence: m.evidence, floor_gib: gib(m.floorBytes), reasons: m.reasons?.slice(0, 2) }))
    }))
  } catch (e) {
    console.log(JSON.stringify({ assessModelFit: execution, error: String(e.message).slice(0, 300) }))
  }
}
await close()
