// Word and character error rate for the speech-to-text evaluation (scripts/eval_fleurs_asr.mjs). Node built-ins only.
//
// Normalizer, applied the same way to the reference and to the model output before scoring:
//   1. Unicode NFKC, lower case
//   2. apostrophes are removed, not split (Swahili "ng'ombe" -> "ngombe"), on both sides
//   3. every other character that is not a letter or a digit (punctuation, symbols, hyphens) becomes a space
//   4. runs of spaces collapse to one, ends trimmed
// Nothing else: number words are NOT turned into digits (or back), spelling variants are not merged.
// WER = (substitutions + deletions + insertions) / reference words, over normalized words.
// CER = the same over the characters of the normalized string (single spaces between words count as characters).

const APOS = /['’‘ʼ`´]/g

export function normalize (s) {
  return String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(APOS, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Levenshtein alignment of two token arrays: { dist, sub, del, ins }. ref = a, hyp = b. */
export function align (a, b) {
  const n = a.length; const m = b.length
  if (n > 5000 || m > 5000) throw new Error('sequence too long to align')
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c)
    }
  }
  // backtrace (prefer match/substitution, then deletion, then insertion) to split the distance into its kinds
  let i = n; let j = m; let sub = 0; let del = 0; let ins = 0
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      if (a[i - 1] !== b[j - 1]) sub++
      i--; j--
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { del++; i-- } else { ins++; j-- }
  }
  return { dist: d[n][m], sub, del, ins }
}

/** Score one reference/hypothesis pair (raw strings; normalized here). */
export function score (ref, hyp) {
  const r = normalize(ref); const h = normalize(hyp)
  const rw = r ? r.split(' ') : []; const hw = h ? h.split(' ') : []
  const w = align(rw, hw)
  const c = align([...r], [...h])
  return {
    ref_words: rw.length,
    ref_chars: [...r].length,
    word_errors: w.dist,
    sub: w.sub,
    del: w.del,
    ins: w.ins,
    char_errors: c.dist,
    wer: rw.length ? w.dist / rw.length : (hw.length ? 1 : 0),
    cer: r.length ? c.dist / [...r].length : (h.length ? 1 : 0)
  }
}

export function median (xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q)
  if (!s.length) return null
  const k = Math.floor(s.length / 2)
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2
}

export function percentile (xs, p) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return null
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
