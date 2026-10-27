// Input level normalization (src/gain.js), applied by src/asr.js before voice detection and speech to text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GAIN, measurePcm16, planGain, applyGain, normalizeWav, pcm16View } from '../src/gain.js'
import { levelAudio } from '../src/asr.js'

const ROOT = new URL('..', import.meta.url).pathname
const RATE = 16000
const db = (x) => 20 * Math.log10(x)

// a 16-bit PCM WAV in memory; `extra` = chunks placed between fmt and data
function wav (samples, { channels = 1, extra = Buffer.alloc(0) } = {}) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((x, i) => data.writeInt16LE(x, i * 2))
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(RATE, 12); fmt.writeUInt32LE(RATE * 2 * channels, 16); fmt.writeUInt16LE(2 * channels, 20); fmt.writeUInt16LE(16, 22)
  const dh = Buffer.alloc(8); dh.write('data', 0, 'ascii'); dh.writeUInt32LE(data.length, 4)
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, extra, dh, data])
  const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}
const sine = (peak, seconds = 1, hz = 440) => Array.from({ length: Math.round(RATE * seconds) }, (_, i) => Math.round(peak * 32767 * Math.sin(2 * Math.PI * hz * i / RATE)))
const samplesOf = (buf) => { const { start, count } = pcm16View(buf); return Int16Array.from({ length: count }, (_, i) => buf.readInt16LE(start + 2 * i)) }

test('a quiet sine is raised to the RMS target (-20 dBFS), with one linear gain', () => {
  const quiet = sine(10 ** (-45 / 20)) // peak -45 dBFS, RMS about -48 dBFS
  const { buf, info } = normalizeWav(wav(quiet))
  assert.ok(info.applied, 'gain applied')
  assert.match(info.reason, /rms/)
  const out = measurePcm16(samplesOf(buf))
  assert.ok(Math.abs(db(out.rms) - -20) < 0.05, `RMS after ${db(out.rms)}`)
  assert.ok(db(out.peak) < -1, 'peak stays under -1 dBFS')
  assert.equal(info.rms_dbfs_after, -20)
  // linear: every output sample is round(x * g) for the same g
  const g = info.gain_db
  assert.ok(g > 27 && g < 29, `gain ${g} dB`)
})

test('a quiet clip with high crest (short bursts) stops at the PEAK target (-1 dBFS)', () => {
  const s = new Array(RATE).fill(0)
  const burst = sine(10 ** (-40 / 20), 0.01) // 10 ms burst at -40 dBFS peak, then silence: crest about 23 dB
  burst.forEach((x, i) => { s[i] = x })
  const { buf, info } = normalizeWav(wav(s))
  assert.ok(info.applied)
  assert.match(info.reason, /peak/)
  const out = measurePcm16(samplesOf(buf))
  assert.ok(Math.abs(db(out.peak) - -1) < 0.02, `peak after ${db(out.peak)}`)
  assert.ok(db(out.rms) < -20)
})

test('very quiet speech-level audio is raised by at most +40 dB', () => {
  const tiny = sine(10 ** (-70 / 20)) // RMS about -73 dBFS (above the -80 dBFS silence floor)
  const { buf, info } = normalizeWav(wav(tiny))
  assert.ok(info.applied)
  assert.match(info.reason, /max_gain/)
  assert.ok(info.gain_db <= 40 && info.gain_db > 39.99, `gain ${info.gain_db}`)
  const out = measurePcm16(samplesOf(buf))
  assert.ok(db(out.rms) < -32 && db(out.rms) > -34, `RMS after ${db(out.rms)}`)
})

test('loud audio is left exactly as it is', () => {
  for (const peak of [1, 0.9, 0.5]) { // 0 dBFS, -0.9 dBFS, -6 dBFS peaks
    const b = wav(sine(peak))
    const { buf, info } = normalizeWav(b)
    assert.ok(buf === null, `peak ${peak}: unchanged`)
    assert.equal(info.applied, false)
    assert.equal(info.reason, 'loud_enough')
  }
  // the app's own test voice notes (about -21 dBFS RMS, -6 dBFS peak) are not touched: e2e results cannot change
  const dir = join(ROOT, 'test/audio')
  const files = readdirSync(dir).filter((f) => f.endsWith('.wav'))
  assert.ok(files.length >= 5)
  for (const f of files) assert.ok(normalizeWav(readFileSync(join(dir, f))).buf === null, `${f} unchanged`)
})

test('digital silence and near-silence are left exactly as they are', () => {
  for (const s of [new Array(RATE).fill(0), Array.from({ length: RATE }, (_, i) => (i % 3) - 1), Array.from({ length: RATE }, (_, i) => (i % 7 === 0 ? 3 : 0))]) {
    const { buf, info } = normalizeWav(wav(s))
    assert.ok(buf === null)
    assert.equal(info.applied, false)
    assert.equal(info.reason, 'silence')
    assert.equal(info.gain_db, 0)
  }
  assert.equal(normalizeWav(wav([])).info.reason, 'silence') // empty data chunk
  assert.equal(planGain({ rms: NaN, peak: NaN }).applied, false)
  assert.ok(GAIN.silenceRms > 0 && GAIN.maxGain === 100)
})

test('no sample ever exceeds full scale', () => {
  // gain applied directly with a huge factor: hard-limited to the 16-bit range
  const x = Int16Array.from([32767, -32768, 20000, -20000, 1, -1, 0])
  const y = applyGain(x, 1000)
  assert.deepEqual([...y], [32767, -32768, 32767, -32768, 1000, -1000, 0])
  // a plan aimed exactly at full scale still keeps every rounded sample in range (and the -32768 corner)
  const s = Int16Array.from({ length: RATE }, (_, i) => ((i * 7919) % 2001) - 1000) // deterministic pseudo-noise
  s[5] = -1001; s[6] = 1001
  const plan = planGain(measurePcm16(s), { ...GAIN, targetPeak: 1, targetRms: 1 })
  assert.ok(plan.applied)
  const out = applyGain(s, plan.gain)
  let max = -Infinity; let min = Infinity
  for (const v of out) { if (v > max) max = v; if (v < min) min = v }
  assert.ok(max <= 32767 && min >= -32768, `range ${min}..${max}`)
  assert.ok(max >= 32700, 'and it does reach (almost) full scale')
  // with the shipped settings the peak lands at -1 dBFS, far from clipping
  const { buf } = normalizeWav(wav(Array.from(s)))
  const after = measurePcm16(samplesOf(buf))
  assert.ok(after.peak <= GAIN.targetPeak + 1 / 32768)
})

test('deterministic: same input, same bytes (pinned)', () => {
  const s = sine(10 ** (-38 / 20), 0.5, 311)
  const a = normalizeWav(wav(s)); const b = normalizeWav(wav(s))
  assert.ok(a.buf && b.buf && a.buf.equals(b.buf))
  assert.deepEqual(a.info, b.info)
  assert.equal(createHash('sha256').update(a.buf).digest('hex').slice(0, 16), '217920ade8fc653b') // pinned: any change to the algorithm or constants shows here
})

test('header and other chunks are kept byte for byte; stereo; odd chunk sizes', () => {
  const list = Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([5, 0, 0, 0]), Buffer.from('INFOx', 'ascii'), Buffer.from([0])]) // odd size + pad byte
  const s = sine(0.01, 0.2)
  const inp = wav(s.flatMap((x) => [x, -x]), { channels: 2, extra: list })
  const { buf, info } = normalizeWav(inp)
  assert.ok(info.applied)
  const { start, count } = pcm16View(inp)
  assert.equal(buf.length, inp.length)
  assert.ok(buf.subarray(0, start).equals(inp.subarray(0, start)), 'everything before the samples unchanged')
  const out = samplesOf(buf)
  for (let i = 0; i < count; i += 2) assert.ok(Math.abs(out[i] + out[i + 1]) <= 1, 'both channels get the same gain (x and -x round to within one step)')
  // the input buffer itself is never modified
  assert.ok(inp.equals(wav(s.flatMap((x) => [x, -x]), { channels: 2, extra: list })))
})

test('refuses what is not 16-bit PCM WAV', () => {
  assert.throws(() => normalizeWav(Buffer.from('not a wav file at all, just some text bytes here ....')), /WAV/)
  assert.throws(() => normalizeWav('RIFF'), /WAV/)
  const f = wav(sine(0.01, 0.1)); f.writeUInt16LE(3, 20) // format tag 3 = float
  assert.throws(() => normalizeWav(f), /16-bit PCM/)
  const b8 = wav(sine(0.01, 0.1)); b8.writeUInt16LE(8, 34) // 8-bit
  assert.throws(() => normalizeWav(b8), /16-bit PCM/)
  const cut = wav(sine(0.01, 0.1)).subarray(0, 40)
  assert.throws(() => normalizeWav(cut), /WAV/)
})

test('levelAudio (src/asr.js): quiet file -> new private temp file, loud file -> the original path; cleanup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gain-test-'))
  try {
    const quiet = join(dir, 'quiet.wav'); writeFileSync(quiet, wav(sine(0.001)))
    const loud = join(dir, 'loud.wav'); writeFileSync(loud, wav(sine(0.5)))
    const a = levelAudio(quiet, dir)
    assert.ok(a.info.applied && a.path !== quiet && a.path.startsWith(dir + '/'))
    assert.ok(existsSync(a.path))
    assert.equal(readFileSync(quiet).equals(wav(sine(0.001))), true, 'the original file is not changed')
    a.cleanup(); assert.ok(!existsSync(a.path), 'temp file removed')
    const b = levelAudio(loud, dir)
    assert.equal(b.path, loud); assert.equal(b.info.applied, false); b.cleanup(); assert.ok(existsSync(loud))
    // a temp dir that is a link (macOS TMPDIR) is resolved; one that is not a directory is refused
    symlinkSync(dir, join(dir, 'link'))
    const c = levelAudio(quiet, join(dir, 'link'))
    assert.ok(c.path.startsWith(realpathSync(dir) + '/') && !c.path.includes('/link/')); c.cleanup()
    assert.throws(() => levelAudio(quiet, loud), /not a directory/)
    // the size cap is enforced on what is actually read
    writeFileSync(join(dir, 'big.wav'), Buffer.alloc(5 * 1024 * 1024 + 1))
    assert.throws(() => levelAudio(join(dir, 'big.wav'), dir), /too large/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
