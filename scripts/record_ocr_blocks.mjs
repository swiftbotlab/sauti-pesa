// Record the raw QVAC OCR output (text blocks + boxes) for the test screenshots, so test/ocr.test.js can replay
// real OCR output through the safety checks without loading a model. Offline sandbox; prints JSON to stdout:
//   ops/sandbox.sh offline node scripts/record_ocr_blocks.mjs > test/data/public/screens/ocr_blocks.json
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { close, ocr } from '@qvac/sdk'
import { LocalOCR } from '../src/ocr.js'

const CFG = JSON.parse(readFileSync('config.json', 'utf8'))
const DIR = 'test/data/public/screens'
const reader = new LocalOCR({ modelPath: realpathSync(CFG.models.ocr), detectorPath: realpathSync(CFG.models.ocr_detector), threads: CFG.ocr_threads || 4 })
await reader.load()
const out = { note: 'Raw blocks from QVAC OCR (@qvac/sdk 0.22.0, OCR_LATIN + OCR_CRAFT, magRatio 1.0, canvasSize 1024), recorded by scripts/record_ocr_blocks.mjs', screens: {} }
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.png')).sort()) {
  const blocks = await ocr({ modelId: reader.modelId, image: readFileSync(`${DIR}/${f}`) }).blocks
  out.screens[f] = blocks.map((b) => ({ text: b.text, bbox: b.bbox?.map((v) => Math.round(v * 10) / 10), confidence: Math.round((b.confidence ?? 0) * 100) / 100 }))
}
await reader.unload()
console.log(JSON.stringify(out, null, 1))
await close()
