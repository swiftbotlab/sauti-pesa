'use strict'
// Download ONE model file from QVAC's own model registry (Hyperswarm / Hyperblobs), for models that QVAC
// distributes only there (the OCR weights). Called by scripts/fetch_registry_model.sh, which runs it in a
// separate network namespace that can reach the internet but not this machine's loopback services or private
// networks, inside bubblewrap with the project read-only. Never run it directly on the host.
//   node scripts/registry_fetch.cjs <KEY> <models.json entry as JSON> <output file>
//
// Before downloading, the entry from models.json is compared with the SDK's own registry constant of the
// same name (node_modules/@qvac/inference, the version pinned in package-lock.json): core key, block range,
// byte offset, size and sha256 must all match. The shell script checks size and sha256 again on the host.
const { QVACRegistryClient } = require('@qvac/registry-client')
const path = require('node:path')
const fs = require('node:fs')

const MAX_BYTES = 200 * 1024 * 1024 // OCR weights are 15 MB and 83 MB
const HARD_TIMEOUT_MS = 10 * 60 * 1000

function fail (msg) { console.error(`registry_fetch: ${msg}`); process.exit(1) }

async function main () {
  const [key, entryJson, out] = process.argv.slice(2)
  if (!/^[A-Z0-9_]{2,60}$/.test(key || '')) fail('bad key')
  let e
  try { e = JSON.parse(entryJson) } catch { fail('entry is not JSON') }
  const stage = process.env.SAUTI_FETCH_STAGE
  if (!stage || !path.isAbsolute(stage)) fail('SAUTI_FETCH_STAGE missing')
  const outAbs = path.resolve(out || '')
  if (path.dirname(outAbs) !== stage) fail('output must be in the staging directory')

  const r = e.registry || {}
  const want = {
    coreKey: r.blobCoreKey, blockOffset: r.blobBlockOffset, blockLength: r.blobBlockLength,
    byteOffset: r.blobByteOffset, byteLength: e.bytes, sha256: e.sha256
  }
  if (!/^[0-9a-f]{64}$/.test(want.coreKey || '')) fail('bad core key')
  for (const k of ['blockOffset', 'blockLength', 'byteOffset', 'byteLength']) {
    if (!Number.isSafeInteger(want[k]) || want[k] < 0) fail(`bad ${k}`)
  }
  if (want.byteLength < 1 || want.byteLength > MAX_BYTES) fail('size out of range')

  // Cross-check with the SDK's registry constant (data only: the module exports plain objects).
  const reg = await import(path.join(process.cwd(), 'node_modules/@qvac/inference/dist/models/registry/models.js'))
  const c = reg[e.qvac_constant]
  if (!c || e.qvac_constant !== key) fail(`no SDK registry constant ${key}`)
  const sdk = {
    coreKey: c.blobCoreKey, blockOffset: c.blobBlockOffset, blockLength: c.blobBlockLength,
    byteOffset: c.blobByteOffset, byteLength: c.expectedSize, sha256: c.sha256Checksum
  }
  for (const k of Object.keys(want)) if (want[k] !== sdk[k]) fail(`${k} in models.json differs from the SDK registry constant`)
  if (r.registryPath !== c.registryPath || r.registrySource !== c.registrySource) fail('registry path differs from the SDK constant')

  const client = new QVACRegistryClient({ storage: path.join(stage, 'corestore') })
  const timer = setTimeout(() => fail('timed out'), HARD_TIMEOUT_MS)
  timer.unref()
  let last = 0
  try {
    await client.downloadBlob(
      { coreKey: want.coreKey, blockOffset: want.blockOffset, blockLength: want.blockLength, byteOffset: want.byteOffset, byteLength: want.byteLength },
      {
        outputFile: outAbs,
        timeout: 120000,
        onProgress: ({ downloaded, total }) => {
          const pct = Math.floor((100 * downloaded) / (total || 1))
          if (pct >= last + 20) { last = pct; console.log(`${key}: ${pct}%`) }
        }
      }
    )
  } finally {
    await client.close().catch(() => {})
  }
  const size = fs.statSync(outAbs).size
  if (size !== want.byteLength) fail(`size ${size} != ${want.byteLength}`)
  console.log(`${key}: downloaded ${size} bytes`)
  process.exit(0)
}

main().catch((err) => fail(err && err.message ? err.message.slice(0, 300) : 'failed'))
