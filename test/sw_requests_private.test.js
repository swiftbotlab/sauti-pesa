// Deterministic checks over the PRIVATE commissioned Swahili test set (not in this repository; see
// scripts/eval_sw_requests.mjs for the file format). Skipped when test/data/private/ does not have it.
// No model, no network: rule-based scam risk and the code's amount reader only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ruleFlags, riskFromFlags } from '../src/scam.js'
import { amountsInText, normalizeNumbers } from '../src/amount.js'

const SET = fileURLToPath(new URL('./data/private/sw_requests_commissioned.md', import.meta.url))
const LABELS = fileURLToPath(new URL('./data/private/sw_requests_commissioned.labels.json', import.meta.url))
const present = existsSync(SET) && existsSync(LABELS)
const skip = present ? false : 'private commissioned test set not present (test/data/private/)'

function load () {
  const rows = []
  for (const line of readFileSync(SET, 'utf8').split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| id ') || line.startsWith('|---')) continue
    const c = line.split('|').slice(1, -1).map((x) => x.trim().slice(0, 1024))
    if (c.length === 10) rows.push({ id: c[0], text: c[2], currency: c[5], register: c[7], scam: c[8] === 'yes' })
  }
  return { rows, labels: JSON.parse(readFileSync(LABELS, 'utf8')) }
}

test('private set: parses (30 everyday requests + 5 scams)', { skip }, () => {
  const { rows } = load()
  assert.equal(rows.length, 35)
  assert.equal(rows.filter((r) => r.scam).length, 5)
})

test('private set: the rules alone rate every scam high and no everyday request high', { skip }, () => {
  const { rows } = load()
  const risk = (r) => riskFromFlags(ruleFlags(r.text))
  assert.deepEqual(rows.filter((r) => r.scam && risk(r) !== 'high').map((r) => r.id), [])
  assert.deepEqual(rows.filter((r) => !r.scam && risk(r) === 'high').map((r) => r.id), [])
})

test('private set: the code reads the amount in every standard-Swahili request', { skip }, () => {
  const { rows, labels } = load()
  const std = rows.filter((r) => !r.scam && r.register === 'standard')
  assert.ok(std.length >= 10)
  const missed = std.filter((r) => !amountsInText(normalizeNumbers(r.text)).has(labels.expected_amount[r.id])).map((r) => r.id)
  assert.deepEqual(missed, [])
})

test('private set: the code reads the Sheng amounts written with thao / soo', { skip }, () => {
  const { rows, labels } = load()
  const sheng = rows.filter((r) => !r.scam && /\b(thao|soo)\b/i.test(r.text))
  assert.ok(sheng.length >= 2)
  const missed = sheng.filter((r) => !amountsInText(normalizeNumbers(r.text)).has(labels.expected_amount[r.id])).map((r) => r.id)
  assert.deepEqual(missed, [])
})
