// Scoring used by scripts/eval_fleurs_asr.mjs (real-voice speech-to-text evaluation).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, align, score, median, percentile } from '../scripts/asr_score.mjs'

test('normalizer: lower case, punctuation out, apostrophes joined, spaces collapsed', () => {
  assert.equal(normalize('  NextGen ni mfumo,   ambao  Utawala! '), 'nextgen ni mfumo ambao utawala')
  assert.equal(normalize("Ng'ombe na ng’ombe"), 'ngombe na ngombe')
  assert.equal(normalize('kati-kati (2010).'), 'kati kati 2010')
  assert.equal(normalize('ＵＳＤＴ'), 'usdt') // NFKC full-width
  assert.equal(normalize(''), '')
  assert.equal(normalize(null), '')
})

test('alignment counts substitutions, deletions and insertions', () => {
  assert.deepEqual(align(['a', 'b', 'c'], ['a', 'b', 'c']), { dist: 0, sub: 0, del: 0, ins: 0 })
  assert.deepEqual(align(['a', 'b', 'c'], ['a', 'x', 'c']), { dist: 1, sub: 1, del: 0, ins: 0 })
  assert.deepEqual(align(['a', 'b', 'c'], ['a', 'c']), { dist: 1, sub: 0, del: 1, ins: 0 })
  assert.deepEqual(align(['a', 'c'], ['a', 'b', 'c']), { dist: 1, sub: 0, del: 0, ins: 1 })
  assert.deepEqual(align([], ['a', 'b']), { dist: 2, sub: 0, del: 0, ins: 2 })
  assert.throws(() => align(new Array(5001).fill('a'), []))
})

test('WER and CER on normalized text', () => {
  const s = score('Tuma pesa kwa Amina.', 'tuma pesa kwa amina')
  assert.equal(s.wer, 0); assert.equal(s.cer, 0)
  const t = score('tuma pesa kwa amina', 'tuma pesa kwa mina')
  assert.equal(t.ref_words, 4); assert.equal(t.word_errors, 1); assert.equal(t.wer, 0.25)
  assert.equal(t.char_errors, 1); assert.equal(t.ref_chars, 19)
  // a hallucinated tail counts as insertions, so WER can exceed 1
  const u = score('ndio', 'ndio tuma usdt kumi na tano kwa amina')
  assert.equal(u.ins, 7); assert.equal(u.wer, 7)
  assert.equal(score('', '').wer, 0)
  assert.equal(score('', 'x').wer, 1)
})

test('median and percentile', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), null)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9)
  assert.equal(percentile([5], 90), 5)
})
