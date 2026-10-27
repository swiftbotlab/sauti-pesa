// Plain-code helpers for reading a screenshot (no model, no SDK import): check the image by content, put the
// OCR blocks in reading order, and repair OCR's O/0 and l/1 confusions inside wallet addresses. Used by src/ocr.js;
// unit-tested in test/ocr.test.js. Nothing here decides whether a message is risky.
import { lstatSync, readFileSync } from 'node:fs'

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_IMAGE_SIDE = 4096
export const MAX_IMAGE_PIXELS = 12_000_000
const MAX_BLOCKS = 400

/**
 * Check by CONTENT that a buffer is a PNG or JPEG we accept, and read its pixel size from the header, so a
 * decompression bomb (a tiny file that decodes to a huge bitmap) is refused before the decoder sees it.
 */
export function inspectImage (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) throw new Error('image is empty or truncated')
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large (max 4 MB)')
  let type = null; let width = 0; let height = 0
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString('ascii', 12, 16) === 'IHDR') {
    type = 'png'; width = buf.readUInt32BE(16); height = buf.readUInt32BE(20)
  } else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    type = 'jpeg'
    let off = 2
    while (off + 9 <= buf.length) {
      if (buf[off] !== 0xff) throw new Error('JPEG structure is broken')
      const marker = buf[off + 1]
      if (marker === 0xff) { off++; continue } // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue }
      if (marker === 0xd9 || marker === 0xda) break // end of image / start of scan before any frame header
      const len = buf.readUInt16BE(off + 2)
      if (len < 2) throw new Error('JPEG structure is broken')
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = buf.readUInt16BE(off + 5); width = buf.readUInt16BE(off + 7); break
      }
      off += 2 + len
    }
  } else throw new Error('image must be a PNG or JPEG screenshot')
  if (!width || !height) throw new Error('image size not found')
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`image is too big (max ${MAX_IMAGE_SIDE} px per side, ${MAX_IMAGE_PIXELS / 1e6} megapixels)`)
  }
  return { type, width, height }
}

/** Read an image file for OCR: a regular file (no symlink), size-capped, PNG/JPEG by content. */
export function readImageFile (path) {
  const st = lstatSync(path)
  if (!st.isFile()) throw new Error('image is not a regular file')
  if (st.size > MAX_IMAGE_BYTES) throw new Error('image too large (max 4 MB)')
  const buf = readFileSync(path)
  return { buf, info: inspectImage(buf) }
}

const HEXISH = /^[0-9a-fA-FOoIl]+$/
const ADDR_START = /^[0Oo][xX][0-9a-fA-FOoIl]*$/

/**
 * OCR blocks -> text in reading order: lines top to bottom, blocks left to right. A block whose vertical centre is
 * within half a line height of the current line belongs to that line. One narrow layout repair: the detector
 * sometimes splits a long unbroken token (a wallet address) into two boxes that touch; a "0x..." fragment and
 * a hex fragment that starts right where it ends (gap under a third of the line height) are joined without a space.
 */
export function blocksToText (blocks) {
  const list = (Array.isArray(blocks) ? blocks : []).slice(0, MAX_BLOCKS)
    .filter((b) => b && typeof b.text === 'string' && b.text.trim())
  const boxed = []; const loose = []
  for (const b of list) {
    const bb = Array.isArray(b.bbox) && b.bbox.length === 4 && b.bbox.every(Number.isFinite) ? b.bbox : null
    if (bb) boxed.push({ text: b.text.trim(), x0: Math.min(bb[0], bb[2]), y0: Math.min(bb[1], bb[3]), x1: Math.max(bb[0], bb[2]), y1: Math.max(bb[1], bb[3]) })
    else loose.push(b.text.trim())
  }
  boxed.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1) || a.x0 - b.x0)
  const lines = []
  for (const b of boxed) {
    const cy = (b.y0 + b.y1) / 2; const h = Math.max(1, b.y1 - b.y0)
    const line = lines.at(-1)
    if (line && Math.abs(cy - line.cy) <= Math.max(h, line.h) / 2) line.items.push(b)
    else lines.push({ cy, h, items: [b] })
  }
  const out = lines.map(({ items, h }) => {
    items.sort((a, b) => a.x0 - b.x0)
    let s = items[0].text
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]; const cur = items[i]
      const lastWord = s.split(/\s+/).at(-1)
      const firstWord = cur.text.split(/\s+/)[0]
      const glue = cur.x0 - prev.x1 <= h / 3 && ADDR_START.test(lastWord) && HEXISH.test(firstWord)
      s += (glue ? '' : ' ') + cur.text
    }
    return s
  })
  return [...out, ...loose].join('\n')
}

/**
 * OCR cannot tell the letter O from the digit 0, or l/I from 1, and hex has no O, I or l. Inside a token that
 * has exactly the shape of an EVM address (0x + 40 characters) and only those confusable letters besides hex,
 * map them back. The EIP-55 checksum check that follows (evmaddr.js) still catches any other misread character.
 */
export function repairAddressTokens (text) {
  return String(text || '').replace(/(?<![0-9A-Za-z_])[0Oo][xX]([0-9a-fA-FOoIl]{40})(?![0-9A-Za-z_])/g,
    (_, body) => '0x' + body.replace(/[Oo]/g, '0').replace(/[Il]/g, '1'))
}
