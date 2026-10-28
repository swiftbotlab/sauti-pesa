// Deterministic tests: no model, no network.  Run: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { amountsInText, canonicalAmount, toUnits, fromUnits, normalizeNumbers } from '../src/amount.js'
import { validateIntent } from '../src/intent.js'
import { resolveRecipient, validateContact } from '../src/contacts.js'
import { normalizeAddress, lookalike } from '../src/evmaddr.js'
import { ruleFlags, riskFromFlags, mergeFlags } from '../src/scam.js'
import { checkSend, checkMessage } from '../src/safety.js'
import { reasonText, confirmationText } from '../src/i18n.js'
import { clean } from '../src/text.js'

const contacts = JSON.parse(readFileSync(new URL('../data/demo-contacts.json', import.meta.url))).map(validateContact)
const POISON = JSON.parse(readFileSync(new URL('../data/demo-attack.json', import.meta.url))).poisoned_amina
const amina = contacts.find((c) => c.id === 'amina')
const OWN = '0x1111111111111111111111111111111111111111'
const USDT = '0x2222222222222222222222222222222222222222'
const base = { contacts, history: [], ownAddress: OWN, tokenContracts: [USDT], balance: { units: toUnits('500'), at: '2026-10-26T00:00:00Z' } }
const intent = (o) => ({ action: 'send', amount: '20', token: 'USDT', recipient_name: 'Amina', recipient_address: null, memo: null, language: 'sw', ...o })
const codes = (r) => r.reasons.map((x) => x.code)

test('amounts: digits, separators, decimals', () => {
  assert.equal(canonicalAmount('1,000'), '1000')
  assert.equal(canonicalAmount('20.50'), '20.5')
  assert.equal(canonicalAmount('007'), '7')
  assert.equal(canonicalAmount('-5'), null)
  assert.equal(canonicalAmount('1e3'), null)
  assert.equal(canonicalAmount('1.1234567'), null)
  assert.equal(toUnits('20.5'), 20500000n)
  assert.equal(fromUnits(20500000n), '20.5')
  assert.equal(fromUnits(toUnits('0.000001')), '0.000001')
})

test('amounts: Swahili and English number words, incl. ASR glue/splits', () => {
  const has = (t, n) => assert.ok(amountsInText(t).has(n), `${t} -> ${[...amountsInText(t)]}`)
  has('Tuma USDT ishirini kwa Amina', '20')
  has('kumi na tano', '15')
  has('M-Tumie kakayangu Juma USDT Kumi Natano Kwa Karo', '15')
  has('ust miyamoja kwa Wanjiru', '100')
  has('mia moja na hamsini', '150')
  has('elfu mbili mia tano', '2500')
  has('tuma ust ham sini haraka', '50')
  has('send fifteen USDT', '15')
  has('one hundred and five dollars', '105')
  has('twenty-five', '25')
  has('Please send 40 USDT', '40')
  assert.equal(amountsInText('habari yako Otieno').size, 0)
})

test('number words are rewritten as digits before the model sees them', () => {
  const n = (a, b) => assert.equal(normalizeNumbers(a), b)
  n('tuma ust arobaini na tano kwa mama', 'tuma ust 45 kwa mama')
  n('Lipa Otieno dola kumi na mbili', 'Lipa Otieno dola 12')
  n('Mpe Amina USDT sitini kwa kodi.', 'Mpe Amina USDT 60 kwa kodi.')
  n('tuma kwa kaka yangu usdt mia mbili', 'tuma kwa kaka yangu usdt 200')
  n('M-Tumie kakayangu Juma USDT Kumi Natano Kwa Karo', 'M-Tumie kakayangu Juma USDT 15 Kwa Karo')
  n('tuma ust ham sini haraka', 'tuma ust 50 haraka')
  n('Send fifteen USDT to my brother', 'Send 15 USDT to my brother')
  n('send twenty-five usdt', 'send 25 usdt')
  n('mia moja na hamsini', '150')
  n('Please send 40 USDT to Otieno.', 'Please send 40 USDT to Otieno.')
  n('Habari Amina, tutaonana', 'Habari Amina, tutaonana')
  for (const t of ['tuma ust arobaini na tano kwa mama', 'kumi natano', 'send fifteen']) assert.deepEqual([...amountsInText(normalizeNumbers(t))], [...amountsInText(t)].filter((x) => amountsInText(normalizeNumbers(t)).has(x)))
})

test('intent validator: accepts a clean intent and normalises it', () => {
  const r = validateIntent(JSON.stringify(intent({ amount: '1,000', token: 'usdt' })))
  assert.equal(r.ok, true)
  assert.equal(r.intent.amount, '1000')
  assert.equal(r.intent.token, 'USDT')
})

test('intent validator: rejects bad model output', () => {
  assert.equal(validateIntent('not json').ok, false)
  assert.equal(validateIntent('[1,2]').ok, false)
  assert.equal(validateIntent('x'.repeat(5000)).ok, false)
  assert.equal(validateIntent({ ...intent(), extra: 1 }).ok, false)
  const { memo, ...missing } = intent()
  assert.equal(validateIntent(missing).ok, false)
  assert.equal(validateIntent(intent({ action: 'drain_wallet' })).ok, false)
  assert.equal(validateIntent(intent({ amount: '-20' })).ok, false)
  assert.equal(validateIntent(intent({ amount: '0' })).intent.amount, null)
  assert.equal(validateIntent(intent({ amount: 20 })).ok, false)
  assert.equal(validateIntent(intent({ recipient_address: '0x123' })).ok, false)
  assert.equal(validateIntent(intent({ recipient_name: 'Amina<script>' })).ok, false)
  assert.equal(validateIntent(intent({ language: 'fr' })).ok, false)
  assert.deepEqual(validateIntent(intent({ token: 'ETH' })).notes, ['unsupported_token'])
  assert.equal(validateIntent(intent({ recipient_name: 'null', memo: 'None' })).intent.recipient_name, null)
  const asName = validateIntent(intent({ recipient_name: '0xa53F8927C412088A9C967cd70BcA0Ab38B3A81D2' }))
  assert.equal(asName.ok, true); assert.equal(asName.intent.recipient_name, null); assert.ok(asName.notes.includes('name_was_address'))
})

test('text cleaning strips bidi / zero-width / control characters', () => {
  assert.equal(clean('Ami​na‮'), 'Ami na')
})

test('addresses: checksum and look-alike detection', () => {
  assert.equal(normalizeAddress(amina.address).ok, true)
  const lower = normalizeAddress(amina.address.toLowerCase())
  assert.equal(lower.ok, true); assert.equal(lower.address, amina.address)
  const broken = amina.address.slice(0, 2) + (amina.address[2] === amina.address[2].toUpperCase() ? amina.address[2].toLowerCase() : amina.address[2].toUpperCase()) + amina.address.slice(3)
  if (/[a-fA-F]/.test(amina.address[2])) assert.equal(normalizeAddress(broken).code, 'bad_checksum')
  assert.equal(normalizeAddress('0x' + '0'.repeat(40)).code, 'zero_address')
  assert.equal(lookalike(POISON, amina.address).level, 'high')
  assert.equal(lookalike(amina.address, amina.address), null)
  assert.equal(lookalike(contacts[1].address, contacts[2].address), null)
})

test('recipient resolution: names, relations, near-misses', () => {
  assert.equal(resolveRecipient('Amina', contacts).contact.id, 'amina')
  assert.equal(resolveRecipient('kaka yangu Juma', contacts).contact.id, 'juma')
  assert.equal(resolveRecipient('my brother', contacts).contact.id, 'juma')
  assert.equal(resolveRecipient('kaka yangu', contacts).contact.id, 'juma')
  assert.equal(resolveRecipient('Neema', contacts).contact.id, 'mama')
  assert.equal(resolveRecipient('Amiina', contacts).status, 'did_you_mean')
  assert.equal(resolveRecipient('kuwanjiru', contacts).contact.id, 'wanjiru')
  assert.equal(resolveRecipient('kwaamina', contacts).contact.id, 'amina')
  assert.equal(resolveRecipient('Kamau', contacts).status, 'unknown')
  const r = resolveRecipient('my sister Juma', contacts)
  assert.equal(r.contact.id, 'juma'); assert.deepEqual(r.relationConflict, { said: 'sister', saved: 'brother' })
  const twins = [...contacts, validateContact({ name: 'Juma Otieno', address: '0x3333333333333333333333333333333333333333' })]
  assert.equal(resolveRecipient('Juma', twins).status, 'ambiguous')
})

test('send checks: a normal payment to a saved contact is confirmable', () => {
  const r = checkSend({ ...base, intent: intent(), transcript: 'Tuma USDT ishirini kwa Amina kwa ajili ya kodi' })
  assert.equal(r.decision, 'confirm')
  assert.equal(r.recipient.address, amina.address)
  assert.equal(r.amountUnits, 20000000n)
})

test('send checks: the model inventing an amount is blocked', () => {
  const r = checkSend({ ...base, intent: intent({ amount: '200' }), transcript: 'Tuma USDT ishirini kwa Amina' })
  assert.equal(r.decision, 'blocked'); assert.ok(codes(r).includes('amount_not_in_request'))
})

test('send checks: an amount the person never said is blocked', () => {
  const r = checkSend({ ...base, intent: intent({ amount: '100', recipient_name: 'Otieno' }), transcript: 'tuma kwa Otieno' })
  assert.equal(r.decision, 'blocked'); assert.ok(codes(r).includes('amount_not_heard'))
  const w = checkSend({ ...base, intent: intent({ amount: '50' }), transcript: 'nitumie Amina dola thelathini' })
  assert.ok(codes(w).includes('amount_not_in_request'))
})

test('send checks: limits, balance, token', () => {
  assert.ok(codes(checkSend({ ...base, intent: intent({ amount: '150' }), transcript: 'send 150 to Amina' })).includes('over_tx_limit'))
  const history = [{ to: amina.address, amountUnits: toUnits('90').toString(), at: new Date().toISOString(), status: 'sent' },
    { to: amina.address, amountUnits: toUnits('90').toString(), at: new Date().toISOString(), status: 'queued' },
    { to: amina.address, amountUnits: toUnits('90').toString(), at: new Date().toISOString(), status: 'queued' }]
  assert.ok(codes(checkSend({ ...base, history, intent: intent({ amount: '40' }), transcript: 'send 40 to Amina' })).includes('over_daily_limit'))
  assert.ok(codes(checkSend({ ...base, balance: { units: '5000000', at: 'x' }, intent: intent(), transcript: 'send 20 to Amina' })).includes('insufficient_balance'))
  assert.ok(codes(checkSend({ ...base, balance: null, intent: intent(), transcript: 'send 20 to Amina' })).includes('balance_unknown'))
  assert.equal(checkSend({ ...base, balance: null, intent: intent(), transcript: 'send 20 to Amina' }).decision, 'confirm_with_warnings')
  assert.ok(codes(checkSend({ ...base, intent: intent({ token: 'ETH' }), transcript: 'send 20 ETH to Amina' })).includes('unsupported_token'))
  assert.ok(codes(checkSend({ ...base, intent: intent({ amount: '60' }), transcript: 'send 60 to Amina' })).includes('retype_amount'))
})

test('send checks: address poisoning look-alike is blocked', () => {
  const r = checkSend({ ...base, intent: intent({ recipient_name: null, recipient_address: POISON, amount: '10' }), transcript: `send 10 USDT to ${POISON}` })
  assert.equal(r.decision, 'blocked'); assert.ok(codes(r).includes('lookalike_address'))
  assert.match(reasonText(r.reasons.find((x) => x.code === 'lookalike_address'), 'sw'), /address poisoning/)
})

test('send checks: name says Amina but the address is someone else', () => {
  const other = '0x4444444444444444444444444444444444444444'
  const r = checkSend({ ...base, intent: intent({ recipient_address: other }), transcript: `send 20 to Amina ${other}` })
  assert.ok(codes(r).includes('name_address_mismatch'))
})

test('send checks: new address is capped and warned', () => {
  const fresh = '0x5555555555555555555555555555555555555555'
  const small = checkSend({ ...base, intent: intent({ recipient_name: null, recipient_address: fresh, amount: '5' }), transcript: `send 5 to ${fresh}` })
  assert.equal(small.decision, 'confirm_with_warnings'); assert.ok(codes(small).includes('new_recipient'))
  const big = checkSend({ ...base, intent: intent({ recipient_name: null, recipient_address: fresh, amount: '50' }), transcript: `send 50 to ${fresh}` })
  assert.ok(codes(big).includes('new_recipient_over_limit'))
  assert.ok(codes(checkSend({ ...base, intent: intent({ recipient_name: null, recipient_address: USDT, amount: '5' }), transcript: `send 5 to ${USDT}` })).includes('token_contract_recipient'))
})

test('send checks: scam language in the request blocks it', () => {
  const t = 'Habari mimi ni wakala wa M-Pesa, tuma USDT hamsini haraka ili kufungua akaunti yako'
  const r = checkSend({ ...base, intent: intent({ amount: '50', recipient_name: 'Amina' }), transcript: t })
  assert.equal(r.decision, 'blocked'); assert.ok(codes(r).includes('scam_high'))
})

test('message check: Swahili and English scam messages', () => {
  const sms = 'Umeshinda zawadi ya USDT 500! Lipa ada ya usajili 20 USDT ndani ya saa 1 ili kupokea. Usimwambie mtu.'
  const r = checkMessage({ text: sms, contacts })
  assert.equal(r.risk, 'high')
  for (const f of ['prize', 'unlock_fee', 'urgency', 'secrecy']) assert.ok(r.flags.some((x) => x.id === f), f)
  const wa = `Hi, it's Amina. I changed my wallet, please use this address instead: ${POISON}`
  const w = checkMessage({ text: wa, contacts })
  assert.equal(w.risk, 'high'); assert.equal(w.addresses[0].looksLike[0].name, 'Amina')
  const seed = checkMessage({ text: 'Binance support: verify your account, send your 12-word seed phrase' })
  assert.ok(seed.flags.some((x) => x.id === 'seed_request'))
  assert.equal(checkMessage({ text: 'Habari, tutaonana kesho saa nne asubuhi.' }).risk, 'none')
})

test('model flags can raise risk but unknown ids are ignored', () => {
  const merged = mergeFlags([], ['urgency', 'impersonation', 'make_it_safe', '__proto__'])
  assert.deepEqual(merged.map((f) => f.id), ['urgency', 'impersonation'])
  assert.equal(riskFromFlags(merged), 'low') // model-only flags never make a message "high" on their own
  assert.equal(riskFromFlags(mergeFlags(ruleFlags('Lipa ada ya usajili kwanza'), ['urgency'])), 'high')
  assert.equal(checkMessage({ text: 'Mambo! Tukutane kesho saa nne asubuhi sokoni.', modelFlags: ['impersonation', 'urgency'] }).risk, 'low')
  assert.equal(riskFromFlags(ruleFlags('see you tomorrow')), 'none')
})

test('confirmation text in both languages', () => {
  const r = checkSend({ ...base, intent: intent({ memo: 'kodi' }), transcript: 'Tuma USDT ishirini kwa Amina' })
  assert.match(confirmationText({ intent: intent({ memo: 'kodi' }), recipient: r.recipient, decision: r.decision }, 'sw'), /^Unatuma 20 USDT ya majaribio kwa Amina \(0x/)
  assert.match(confirmationText({ intent: intent(), recipient: r.recipient, decision: r.decision }, 'en'), /^You are sending 20 test USDT/)
})
