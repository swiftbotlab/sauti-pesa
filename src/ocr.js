// On-device text reading for "Check a message" from a SCREENSHOT, via QVAC OCR (@qvac/sdk ocr(): the EasyOCR
// pipeline on GGUF weights, CRAFT text detector + latin_g2 recognizer). Runs fully on the device.
// OCR only turns pixels into text. That text then goes through exactly the same code as pasted text
// (pipeline.analyzeMessage -> safety.checkMessage: scam.js rules, look-alike addresses, i18n explanation).
// Nothing here decides whether a message is risky.
import { loadModel, ocr, unloadModel } from '@qvac/sdk'
import { clean } from './text.js'
import { MAX_MESSAGE_CHARS } from './scam.js'
import { inspectImage, blocksToText, repairAddressTokens } from './ocrtext.js'

export { inspectImage, readImageFile, blocksToText, repairAddressTokens, MAX_IMAGE_BYTES } from './ocrtext.js'

export class LocalOCR {
  /**
   * @param {object} o
   * @param {number} [o.magRatio] detection magnification. 1.0 reads a phone screenshot well; 1.5 (the addon's
   *   default) took about twice as long and about 1 GB more memory on our test screenshots.
   * @param {number} [o.canvasSize] cap on the detection canvas (long side, px): bounds memory for big screenshots.
   */
  constructor ({ modelPath, detectorPath, threads = 4, magRatio = 1.0, canvasSize = 1024 }) {
    Object.assign(this, { modelPath, detectorPath, threads, magRatio, canvasSize })
    this.modelId = null
    this.loadMs = 0
  }

  async load () {
    const t = Date.now()
    this.modelId = await loadModel({
      modelSrc: this.modelPath,
      modelType: 'ggml-ocr',
      modelConfig: {
        detectorModelSrc: this.detectorPath,
        langList: ['en'], // the Latin character set; Swahili needs no other letters
        magRatio: this.magRatio,
        canvasSize: this.canvasSize,
        nThreads: this.threads
      }
    })
    this.loadMs = Date.now() - t
    return this.loadMs
  }

  /** @param {Buffer} buf PNG or JPEG bytes  @returns {Promise<{text:string, ms:number, blocks:number, image:object}>} */
  async read (buf) {
    const image = inspectImage(buf)
    if (!this.modelId) await this.load()
    const t = Date.now()
    const blocks = await ocr({ modelId: this.modelId, image: buf }).blocks
    const text = clean(repairAddressTokens(blocksToText(blocks)), MAX_MESSAGE_CHARS)
    return { text, ms: Date.now() - t, blocks: blocks.length, image }
  }

  async unload () {
    if (this.modelId) await unloadModel({ modelId: this.modelId })
    this.modelId = null
  }
}
