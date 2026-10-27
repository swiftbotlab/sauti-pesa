// "Check a message" from a screenshot, without a model: the image checks, the reading-order layout, the O/0 repair
// inside addresses, and REAL recorded QVAC OCR output (test/data/public/screens/ocr_blocks.json) replayed through
// the same safety checks as pasted text. The live model run is test/e2e_ocr.sh. Each check has a control.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, symlinkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectImage, readImageFile, blocksToText, repairAddressTokens, MAX_IMAGE_BYTES } from '../src/ocrtext.js'
import { checkMessage } from '../src/safety.js'
import { validateContact } from '../src/contacts.js'
import { extractAddresses, normalizeAddress } from '../src/evmaddr.js'
import { clean } from '../src/text.js'

const DIR = fileURLToPath(new URL('./data/public/screens/', import.meta.url))
const contacts = JSON.parse(readFileSync(new URL('../data/demo-contacts.json', import.meta.url))).map(validateContact)
const LOOKALIKE = JSON.parse(readFileSync(new URL('../data/demo-attack.json', import.meta.url))).poisoned_amina
const recorded = JSON.parse(readFileSync(join(DIR, 'ocr_blocks.json'), 'utf8')).screens
const labels = JSON.parse(readFileSync(join(DIR, 'labels.json'), 'utf8')).screens
const RANK = { none: 0, low: 1, medium: 2, high: 3 }
const textOf = (blocks) => clean(repairAddressTokens(blocksToText(blocks)), 2000)

function png (w, h) {
  const b = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}
function jpeg (w, h) {
  // SOI, an APP0 segment, then a baseline frame header (SOF0) with the size
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)])
}

test('image check: PNG and JPEG by content, with their size', () => {
  for (const f of Object.keys(labels)) {
    const info = inspectImage(readFileSync(join(DIR, f)))
    assert.equal(info.type, 'png'); assert.equal(info.width, 720); assert.ok(info.height >= 700)
  }
  assert.deepEqual(inspectImage(jpeg(1080, 2400)), { type: 'jpeg', width: 1080, height: 2400 })
})

test('image check: refuses other files, truncated files, oversized pixels and bytes', () => {
  const wav = readFileSync(new URL('./audio/sw_juma_15.wav', import.meta.url))
  assert.throws(() => inspectImage(wav), /PNG or JPEG/)
  assert.throws(() => inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>                      ')), /PNG or JPEG/)
  assert.throws(() => inspectImage(png(720, 700).subarray(0, 20)), /empty or truncated/)
  // a decompression bomb announces its size in the header: refused before any decoder runs
  assert.throws(() => inspectImage(png(50000, 50000)), /too big/)
  assert.throws(() => inspectImage(png(4000, 4000)), /too big/) // 16 MP > 12 MP
  assert.throws(() => inspectImage(jpeg(5000, 100)), /too big/)
  assert.ok(inspectImage(png(3000, 4000))) // control: 12 MP, at the limit, is accepted
  const big = Buffer.concat([png(720, 700), Buffer.alloc(MAX_IMAGE_BYTES)])
  assert.throws(() => inspectImage(big), /too large/)
  const broken = jpeg(100, 100); broken[20] = 0x00 // the next segment does not start with 0xff
  assert.throws(() => inspectImage(broken), /broken|size not found/)
})

test('image file: regular files only (no symlinks, no directories)', () => {
  const tmp = mkdtempSync(join(fileURLToPath(new URL('../tmp/', import.meta.url)), 'ocrtest-'))
  try {
    const real = join(tmp, 'shot.png')
    writeFileSync(real, readFileSync(join(DIR, 'sw_kawaida.png')))
    assert.equal(readImageFile(real).info.type, 'png') // control
    const link = join(tmp, 'link.png'); symlinkSync(real, link)
    assert.throws(() => readImageFile(link), /regular file/)
    assert.throws(() => readImageFile(tmp), /regular file/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('layout: reading order, and a wallet address split into two touching boxes is joined', () => {
  const blocks = [
    { text: 'cd7OBcAOAb38B3A81D2', bbox: [372, 370, 646, 396] },
    { text: 'anwani mpya:', bbox: [48, 257, 267, 297] },
    { text: 'Oxa53F8927C412088A9C967', bbox: [50, 370, 376, 396] },
    { text: 'Habari!', bbox: [50, 171, 160, 208] },
    { text: 'Nimebadilisha wallet', bbox: [170, 171, 490, 208] }
  ]
  const t = blocksToText(blocks)
  assert.equal(t, 'Habari! Nimebadilisha wallet\nanwani mpya:\nOxa53F8927C412088A9C967cd7OBcAOAb38B3A81D2')
  // control: ordinary words in touching boxes keep their space (only an "0x..." fragment is glued)
  assert.equal(blocksToText([{ text: 'you have won', bbox: [50, 175, 436, 212] }, { text: '500 USDT', bbox: [437, 175, 574, 206] }]), 'you have won 500 USDT')
  // control: an address fragment far from the next box is not glued
  assert.equal(blocksToText([{ text: '0xabc', bbox: [0, 0, 100, 30] }, { text: 'def', bbox: [200, 0, 260, 30] }]), '0xabc def')
  assert.equal(blocksToText([]), '')
  assert.equal(blocksToText([{ text: 'no box' }, { text: 'boxed', bbox: [0, 0, 10, 10] }]), 'boxed\nno box')
})

test('address repair: O->0 and l/I->1 only inside an address-shaped token', () => {
  const ocrd = 'Oxa53F8927C412088A9C967cd7OBcAOAb38B3A81D2'
  assert.equal(extractAddresses(ocrd).length, 0, 'control: as OCR read it, it is not an address')
  const fixed = repairAddressTokens(`tuma kwa ${ocrd} leo`)
  assert.equal(fixed, `tuma kwa ${LOOKALIKE} leo`)
  assert.ok(normalizeAddress(extractAddresses(fixed)[0]).ok, 'the repaired address passes the EIP-55 checksum')
  assert.equal(repairAddressTokens('lx0000000000000000000000000000000000000000'), 'lx0000000000000000000000000000000000000000') // not 0x/Ox
  assert.equal(repairAddressTokens('Oxford Oil'), 'Oxford Oil') // words are left alone
  assert.equal(repairAddressTokens('0x' + 'a'.repeat(41)), '0x' + 'a'.repeat(41)) // 41 characters: not an address shape
  // a misread that is NOT one of the confusable letters is not "repaired": the checksum still catches it
  const wrong = repairAddressTokens(ocrd.replace('F89', 'E89'))
  assert.equal(normalizeAddress(extractAddresses(wrong)[0]).code, 'bad_checksum')
})

test('recorded QVAC OCR output -> the same message checks as pasted text -> expected verdicts', () => {
  assert.deepEqual(Object.keys(recorded).sort(), Object.keys(labels).sort())
  for (const [f, want] of Object.entries(labels)) {
    const text = textOf(recorded[f])
    const r = checkMessage({ text, contacts, history: [] })
    const rules = r.flags.filter((x) => x.source === 'rule').map((x) => x.id)
    if (want.risk) assert.equal(r.risk, want.risk, `${f}: risk`)
    if (want.risk_max) assert.ok(RANK[r.risk] <= RANK[want.risk_max], `${f}: risk ${r.risk} > ${want.risk_max}`)
    for (const id of want.rule_flags) assert.ok(rules.includes(id), `${f}: missing rule flag ${id} in ${rules}`)
    const look = r.addresses.flatMap((a) => a.looksLike.map((l) => l.name))
    if (want.lookalike_of) assert.deepEqual(look, [want.lookalike_of], `${f}: look-alike`)
    else assert.deepEqual(look, [], `${f}: no look-alike expected`)
  }
  // control: without the address repair the look-alike would be missed (the OCR reads O for 0)
  const raw = clean(blocksToText(recorded['sw_anwani_mpya.png']), 2000)
  assert.equal(checkMessage({ text: raw, contacts, history: [] }).addresses.length, 0)
})
