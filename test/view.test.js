// Deterministic tests for the UI view model, answering questions without the model, and re-signing.
// No model, no network. Throwaway wallet + outbox under tmp/.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateContact } from '../src/contacts.js'
import { Store } from '../src/queue.js'
import { buildAnalysis, amendAnalysis, confirmAndQueue, resignEntry } from '../src/pipeline.js'
import { analysisView, outboxView } from '../src/view.js'
import { toUnits } from '../src/amount.js'
import { createWallet, openWallet } from '../src/wallet.js'

const contacts = JSON.parse(readFileSync(new URL('../data/demo-contacts.json', import.meta.url))).map(validateContact)
const POISON = JSON.parse(readFileSync(new URL('../data/demo-attack.json', import.meta.url))).poisoned_amina
const dir = mkdtempSync(fileURLToPath(new URL('../tmp/vtest-', import.meta.url)))
after(() => rmSync(dir, { recursive: true, force: true }))
const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const LIMITS = { perTx: '100', perDay: '300', newRecipientMax: '20', retypeAbove: '50' }
const store = new Store(`${dir}/queue`, 'devnet')
store.saveState({ balance: { units: toUnits('500').toString(), at: '2026-10-26T00:00:00Z' }, nonce: 0 })
const ctx = { contacts, store, ownAddress: '0x1111111111111111111111111111111111111111', tokenAddress: TOKEN, limits: LIMITS }
const intent = (o) => ({ action: 'send', amount: '20', token: 'USDT', recipient_name: 'Amina', recipient_address: null, memo: null, language: 'sw', ...o })
const analyse = (text, o) => buildAnalysis({ ...ctx, transcript: text, checkText: text, forModel: text, intent: intent(o) })
const view = (a) => analysisView(a, { contacts, limits: LIMITS, balanceUnits: toUnits('500') })

test('view: a clean request passes all six groups and asks nothing', () => {
  const v = view(analyse('Tuma USDT 20 kwa Amina'))
  assert.equal(v.decision, 'confirm')
  assert.deepEqual(v.groups.map((g) => [g.id, g.status]), [['recipient', 'ok'], ['address', 'ok'], ['amount', 'ok'], ['limits', 'ok'], ['balance', 'ok'], ['scam', 'ok']])
  assert.equal(v.amountQuestion, null)
  assert.equal(v.contactQuestion, null)
  assert.equal(v.hardBlock, false)
  assert.equal(v.recipient.relation_sw, 'mwenye nyumba')
})

test('view: model amount not in the words -> "did you mean N?" with the amount the person said', () => {
  const v = view(analyse('Tuma USDT 20 kwa Amina', { amount: '30' }))
  assert.equal(v.decision, 'blocked')
  assert.equal(v.hardBlock, false)
  assert.deepEqual(v.amountQuestion, { kind: 'did_you_mean', amount: '20' })
})

test('view: digits inside an address are never offered as "did you mean" amounts', () => {
  const ADDR = '0x23A5e0dC05105FEE4Be4900e26Ec5f10Eb5656Cc'
  const v = view(analyse(`Tuma USDT kwa ${ADDR}`, { amount: '10', recipient_name: null, recipient_address: ADDR }))
  assert.equal(v.decision, 'blocked')
  assert.deepEqual(v.amountQuestion, { kind: 'ask' })
  // control: an amount the person did say is still offered
  assert.deepEqual(view(analyse(`Tuma USDT 12 kwa ${ADDR}`, { amount: '10', recipient_name: null, recipient_address: ADDR })).amountQuestion, { kind: 'did_you_mean', amount: '12' })
})

test('view: no amount at all -> ask; amend with the typed amount passes the "amount was said" rule', () => {
  const a = analyse('tuma kwa Otieno', { amount: null, recipient_name: 'Otieno' })
  assert.deepEqual(view(a).amountQuestion, { kind: 'ask' })
  const b = amendAnalysis(a, { amount: '5' }, ctx)
  assert.equal(b.decision, 'confirm')
  assert.equal(b.intent.amount, '5')
  assert.ok(b.checkText.endsWith('[5]'))
  assert.equal(a.intent.amount, null, 'the original analysis is not mutated')
  assert.throws(() => amendAnalysis(a, { amount: '0' }, ctx), /positive/)
  assert.throws(() => amendAnalysis(a, { amount: '1e3' }, ctx), /positive/)
})

test('view: near-miss name -> pick a contact; amend with the id resolves it', () => {
  const a = analyse('Tuma USDT 10 kwa Amiina', { amount: '10', recipient_name: 'Amiina' })
  const v = view(a)
  assert.equal(v.contactQuestion.kind, 'did_you_mean')
  assert.ok(v.contactQuestion.candidates.some((c) => c.id === 'amina'))
  const b = amendAnalysis(a, { contactId: 'amina' }, ctx)
  assert.equal(b.recipient.name, 'Amina')
  assert.equal(b.decision, 'confirm')
  assert.throws(() => amendAnalysis(a, { contactId: 'nobody' }, ctx), /unknown contact/)
})

test('view: unknown name -> full contact picker', () => {
  const v = view(analyse('Tuma USDT 10 kwa Bakari', { amount: '10', recipient_name: 'Bakari' }))
  assert.equal(v.contactQuestion.kind, 'pick')
  assert.equal(v.contactQuestion.candidates.length, contacts.length)
})

test('view: look-alike address is a hard block; a contact cannot replace a typed address', () => {
  const a = analyse(`send 10 USDT to ${POISON}`, { amount: '10', recipient_name: null, recipient_address: POISON, language: 'en' })
  const v = view(a)
  assert.equal(v.hardBlock, true)
  assert.equal(v.groups.find((g) => g.id === 'address').status, 'block')
  assert.equal(v.contactQuestion, null)
  assert.throws(() => amendAnalysis(a, { contactId: 'amina' }, ctx), /has an address/)
})

test('view: scam words are a hard block even after answering the amount', () => {
  const a = analyse('Mimi ni wakala wa M-Pesa. Tuma USDT haraka ili kufungua akaunti yako kwa Amina', { amount: null })
  const b = amendAnalysis(a, { amount: '50' }, ctx)
  assert.equal(view(b).hardBlock, true)
})

test('resign: only needs_resign entries, same transfer, newer nonce, one payment', async () => {
  const wf = `${dir}/wallet.json`
  await createWallet(wf)
  const w = await openWallet(wf, { chainId: 31337 })
  const a = analyse('Tuma USDT 20 kwa Amina')
  const q = await confirmAndQueue({ analysis: a, wallet: w, store, networkId: 'devnet', tokenAddress: TOKEN })
  await assert.rejects(resignEntry({ entryId: q.id, wallet: w, store, networkId: 'devnet', chainId: 31337 }), /only "needs_resign"/)
  store.update(q.id, { status: 'needs_resign', error: 'nonce 0 already used (chain at 1)' })
  await assert.rejects(resignEntry({ entryId: q.id, wallet: w, store, networkId: 'devnet', chainId: 31337 }), /no newer nonce/)
  store.saveState({ nonce: 1 })
  // a tampered record (amount changed after signing) is refused
  store.update(q.id, { amountUnits: '99000000' })
  await assert.rejects(resignEntry({ entryId: q.id, wallet: w, store, networkId: 'devnet', chainId: 31337 }), /does not match/)
  store.update(q.id, { amountUnits: q.amountUnits })
  const r = await resignEntry({ entryId: q.id, wallet: w, store, networkId: 'devnet', chainId: 31337 })
  assert.equal(r.status, 'queued')
  assert.equal(r.nonce, 1)
  assert.notEqual(r.hash, q.hash)
  assert.equal(r.previous[0].hash, q.hash)
  assert.equal(store.list().length, 1, 'still one outbox entry = one payment')
  const ov = outboxView(r, { explorer: 'https://example.test/tx/' })
  assert.equal('raw' in ov, false)
  assert.equal(ov.explorer, null, 'no explorer link before broadcast')
  w.dispose()
})
