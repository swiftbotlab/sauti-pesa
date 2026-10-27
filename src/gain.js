// Input level normalization for voice notes, BEFORE voice detection and speech to text.
//
// Very quiet recordings (a phone far away, a low mic setting) can come back from Whisper + Silero VAD as no text at
// all. This raises a QUIET clip with ONE linear gain for the whole clip:
//   - target: the peak reaches -1 dBFS, or the RMS reaches -20 dBFS, whichever comes first (the smaller gain);
//   - never more than +40 dB;
//   - only when the clip is quiet: if the gain needed is under +6 dB the audio is left exactly as it is;
//   - digital silence and near-silence (RMS under -80 dBFS) is left exactly as it is;
//   - never attenuates, never clips (every sample is also hard-limited to the 16-bit range).
// No compression, filtering, trimming or resampling: the shape of the signal is unchanged.
// Pure JS, no dependencies. Deterministic: integer sums, IEEE division and sqrt, fixed constants, Math.round.
// Input is 16-bit PCM WAV (what src/asr.js inspectWav accepts); every other format is refused here as well.

export const GAIN = Object.freeze({
  targetPeak: 0.8912509381337456, // 10^(-1/20)  = -1 dBFS
  targetRms: 0.1, //                 10^(-20/20) = -20 dBFS
  maxGain: 100, //                   10^(40/20)  = +40 dB
  minGain: 1.9952623149688795, //    10^(6/20)   = +6 dB: below this the clip is not "quiet"; left unchanged
  silenceRms: 0.0001 //              10^(-80/20) = -80 dBFS RMS: silence or near-silence, left unchanged
})

const FULL = 32768
const dbfs = (x) => (x > 0 ? +(20 * Math.log10(x)).toFixed(1) : null) // null = digital silence (-inf)

/** RMS and peak of 16-bit samples, as fractions of full scale (0..1). */
export function measurePcm16 (samples) {
  let acc = 0; let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]
    acc += x * x // exact: at most 2^30 per sample, 2.9M samples (30 s, 48 kHz stereo) stay below 2^53
    const a = x < 0 ? -x : x
    if (a > peak) peak = a
  }
  const rms = samples.length ? Math.sqrt(acc / samples.length) / FULL : 0
  return { rms, peak: peak / FULL, rms_dbfs: dbfs(rms), peak_dbfs: dbfs(peak / FULL) }
}

/** Decide the one gain for a clip from its RMS and peak (fractions of full scale). */
export function planGain ({ rms, peak }, o = GAIN) {
  if (!(rms >= o.silenceRms) || !(peak > 0)) return { gain: 1, gain_db: 0, applied: false, reason: 'silence' }
  const byPeak = o.targetPeak / peak
  const byRms = o.targetRms / rms
  let gain = Math.min(byPeak, byRms, o.maxGain)
  const limit = byPeak <= byRms && byPeak <= o.maxGain ? 'peak' : byRms <= o.maxGain ? 'rms' : 'max_gain'
  if (!(gain >= o.minGain)) return { gain: 1, gain_db: 0, applied: false, reason: 'loud_enough' }
  // the peak sample may round up by half a step: keep a hard guarantee that nothing exceeds full scale
  if (peak * gain * FULL > 32767) gain = 32767 / (peak * FULL)
  return { gain, gain_db: +(20 * Math.log10(gain)).toFixed(2), applied: true, reason: `raised (${limit} limit)` }
}

/** One linear gain, rounded to the nearest step and hard-limited to the 16-bit range. Returns a new array. */
export function applyGain (samples, gain) {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const y = Math.round(samples[i] * gain)
    out[i] = y > 32767 ? 32767 : y < -32768 ? -32768 : y
  }
  return out
}

/** Find the PCM16 data of a WAV held in memory. Throws on anything else. */
export function pcm16View (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw new Error('audio is not a WAV file')
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('audio must be a WAV file (RIFF/WAVE)')
  let off = 12; let fmt = null
  for (let n = 0; off + 8 <= buf.length && n < 64; n++) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ' && size >= 16 && off + 8 + 16 <= buf.length) fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), bits: buf.readUInt16LE(off + 22) }
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error('WAV must be 16-bit PCM')
      const start = off + 8
      const bytes = Math.min(size, buf.length - start) & ~1
      return { start, count: bytes / 2 }
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('WAV header is incomplete')
}

/**
 * Normalize the level of a 16-bit PCM WAV held in memory.
 * @returns {{ buf: Buffer|null, info: object }} buf is a NEW WAV (same header and chunks, new samples) when a gain
 *   was applied, null when the clip is left unchanged. info: levels before (and after), gain_db, applied, reason.
 */
export function normalizeWav (buf, o = GAIN) {
  const { start, count } = pcm16View(buf)
  // copy into an aligned Int16Array (the data chunk may start at an odd byte offset); WAV is little-endian
  const samples = new Int16Array(count)
  for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(start + 2 * i)
  const before = measurePcm16(samples)
  const plan = planGain(before, o)
  const info = { rms_dbfs: before.rms_dbfs, peak_dbfs: before.peak_dbfs, gain_db: plan.gain_db, applied: plan.applied, reason: plan.reason }
  if (!plan.applied) return { buf: null, info }
  const raised = applyGain(samples, plan.gain)
  const out = Buffer.from(buf) // copy: header and any other chunks stay byte for byte
  for (let i = 0; i < count; i++) out.writeInt16LE(raised[i], start + 2 * i)
  const after = measurePcm16(raised)
  return { buf: out, info: { ...info, rms_dbfs_after: after.rms_dbfs, peak_dbfs_after: after.peak_dbfs } }
}
