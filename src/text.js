// Text hygiene shared by every module. All outside text (speech transcripts, pasted messages,
// model output) passes through here before it is matched, shown or stored.

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g

export const MAX_INPUT_CHARS = 2000

/** Remove control, zero-width and bidi characters; NFKC-normalise; cap the length. */
export function clean (s, max = MAX_INPUT_CHARS) {
  if (typeof s !== 'string') return ''
  return s.normalize('NFKC').replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max)
}

/** Lower-case, strip accents and punctuation, collapse spaces: for matching only, never for display. */
export function fold (s) {
  return clean(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function words (s) {
  return fold(s).split(' ').filter(Boolean)
}

/** Optimal-string-alignment distance (Levenshtein + adjacent transposition), capped for speed. */
export function editDistance (a, b, cap = 4) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/** Shorten an address for display: 0x1234…abcd */
export function shortAddr (a) {
  return typeof a === 'string' && a.length === 42 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a)
}
