// Checks on the person's own words: amount and recipient must really be said, shillings never become USDT, scam
// rules. Several were added after an evaluation on a private, commissioned Swahili test set; the sentences here are
// our own. Deterministic: no model, no network. Each block has a positive and a negative control.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toUnits, amountsInText, normalizeNumbers } from '../src/amount.js'
import { resolveRecipient, validateContact, namedInText } from '../src/contacts.js'
import { ruleFlags, riskFromFlags, mergeFlags } from '../src/scam.js'
import { checkSend, checkMessage, fiatInText } from '../src/safety.js'
import { extractAddresses } from '../src/evmaddr.js'
import { reasonText } from '../src/i18n.js'

const contacts = JSON.parse(readFileSync(new URL('../data/demo-contacts.json', import.meta.url))).map(validateContact)
const byId = (id) => contacts.find((c) => c.id === id)
const base = { contacts, history: [], ownAddress: '0x1111111111111111111111111111111111111111', tokenContracts: [], balance: { units: toUnits('500'), at: '2026-10-26T00:00:00Z' } }
const intent = (o) => ({ action: 'send', amount: '20', token: 'USDT', recipient_name: 'Juma', recipient_address: null, memo: null, language: 'sw', ...o })
const codes = (r) => r.reasons.map((x) => x.code)
const ADDR = '0x23A5e0dC05105FEE4Be4900e26Ec5f10Eb5656Cc' // the public test wallet; its hex contains "10", "23", "05105"

test('amount: digits inside an address are not "said"', () => {
  assert.ok(ADDR.includes('10'), 'control: the address really contains the digits 10')
  const bad = checkSend({ ...base, intent: intent({ amount: '10', recipient_name: null, recipient_address: ADDR }), transcript: `Tuma USDT kwa ${ADDR}` })
  assert.notEqual(bad.decision, 'confirm')
  assert.notEqual(bad.decision, 'confirm_with_warnings')
  assert.ok(codes(bad).includes('amount_not_heard'))
  assert.equal(amountsInText(`Tuma USDT kwa ${ADDR}`).size, 0)
  // control: the same payment with the amount said is not blocked by the amount check
  const good = checkSend({ ...base, intent: intent({ amount: '10', recipient_name: null, recipient_address: ADDR }), transcript: `Tuma USDT 10 kwa ${ADDR}` })
  assert.ok(!codes(good).some((c) => c.startsWith('amount_')))
  assert.equal(good.decision, 'confirm_with_warnings') // new recipient (a warning only)
})

test('amount: a lone "one" / "moja" is not an amount, "one USDT" is', () => {
  const bad = checkSend({ ...base, intent: intent({ amount: '1' }), transcript: 'send USDT to Juma, the one from church' })
  assert.equal(bad.decision, 'blocked')
  assert.ok(codes(bad).includes('amount_not_heard'))
  assert.equal(normalizeNumbers('send USDT to Juma, the one from church'), 'send USDT to Juma, the one from church', 'the model does not see a 1 either')
  assert.equal(amountsInText('Tuma USDT kwa Juma, siku moja').size, 0)
  // controls
  assert.equal(checkSend({ ...base, intent: intent({ amount: '1' }), transcript: 'send one USDT to Juma' }).decision, 'confirm')
  assert.deepEqual([...amountsInText('Tuma dola moja kwa Juma')], ['1'])
  assert.deepEqual([...amountsInText('Tuma USDT mia moja kwa Juma')], ['100'])
  assert.deepEqual([...amountsInText('one hundred and five dollars')], ['105'])
  // digits glued into words do not count, a currency written right after does
  assert.equal(amountsInText('Juma2 tuma').size, 0)
  assert.deepEqual([...amountsInText('send 20usdt to Juma')], ['20'])
  assert.deepEqual([...amountsInText('Tuma USDT 1,500.50')], ['1500.5'])
})

test('recipient must be named in the person\'s own words (the model can invent a contact)', () => {
  // negative control: the name is said -> no new block
  const ok = checkSend({ ...base, intent: intent(), transcript: 'Tuma USDT 20 kwa Juma' })
  assert.equal(ok.decision, 'confirm')
  // the model returned a saved contact that was never said
  const bad = checkSend({ ...base, intent: intent(), transcript: 'Tuma USDT 20 kwa kikundi chetu cha akiba' })
  assert.equal(bad.decision, 'blocked')
  assert.ok(codes(bad).includes('recipient_not_in_request'))
  assert.match(reasonText(bad.reasons.find((r) => r.code === 'recipient_not_in_request'), 'en'), /did not hear Juma's name/)
  // a relation said instead of the name still counts; speech-recogniser glue still counts
  assert.equal(checkSend({ ...base, intent: intent({ recipient_name: 'kaka yangu' }), transcript: 'Mtumie kaka yangu USDT 20' }).decision, 'confirm')
  assert.equal(checkSend({ ...base, intent: intent({ recipient_name: 'Wanjiru' }), transcript: 'Tuma USDT 20 kuwanjiru' }).decision, 'confirm')
  // a relation that was not said does not count
  assert.equal(namedInText(byId('juma'), 'relation', 'Tuma USDT 20 kwa mama'), false)
  assert.equal(namedInText(byId('juma'), 'name', 'tuma USDT 20 kwa Juma Mwangi', contacts), true)
})

test('recipient: a family name, title or relation word in the text does not name a different contact', () => {
  // "Wanjiku" is the family name in Amina's alias "Amina Wanjiku"; the request is for an aunt
  const aunt = checkSend({ ...base, intent: intent({ amount: '15', recipient_name: 'Amina' }), transcript: 'Mtumie shangazi Wanjiku USDT 15 za dawa' })
  assert.notEqual(aunt.decision, 'confirm')
  assert.ok(codes(aunt).includes('recipient_not_in_request'))
  // "Mwangi" is the family name in Juma's alias "Juma Mwangi"; the request is for a craftsman
  const fundi = checkSend({ ...base, intent: intent({ amount: '15', recipient_name: 'Juma' }), transcript: 'Tuma USDT 15 kwa fundi Mwangi' })
  assert.notEqual(fundi.decision, 'confirm')
  assert.ok(codes(fundi).includes('recipient_not_in_request'))
  // "mama" alone does not name "Mama Neema" by NAME (it can by relation, see above)
  assert.equal(namedInText(byId('mama'), 'name', 'tuma USDT 10 kwa mama', contacts), false)
  assert.equal(namedInText(byId('mama'), 'name', 'tuma USDT 10 kwa Neema', contacts), true)
  assert.equal(namedInText(byId('mama'), 'name', 'tuma USDT 10 kwa Mama Neema', contacts), true)
  // controls: the full alias and the first name still name them
  assert.equal(checkSend({ ...base, intent: intent({ amount: '15', recipient_name: 'Amina' }), transcript: 'Mtumie Amina Wanjiku USDT 15' }).decision, 'confirm')
  assert.equal(checkSend({ ...base, intent: intent({ amount: '15', recipient_name: 'Juma' }), transcript: 'Tuma USDT 15 kwa Juma' }).decision, 'confirm')
  // a first name two contacts share does not pick one of them
  const two = [...contacts, validateContact({ name: 'Juma Hassan', address: '0x2222222222222222222222222222222222222222' })]
  assert.equal(namedInText(byId('juma'), 'name', 'Tuma USDT 15 kwa Juma', two), false)
  assert.equal(namedInText(byId('juma'), 'name', 'Tuma USDT 15 kwa Juma Mwangi', two), true)
  // the person picking the contact on screen counts as naming it
  assert.equal(checkSend({ ...base, intent: intent({ amount: '15', recipient_name: 'Amina' }), transcript: 'Mtumie shangazi Wanjiku USDT 15 za dawa [Amina]', pickedContactId: 'amina' }).decision, 'confirm')
})

test('a family name alone never auto-picks a contact', () => {
  const r = resolveRecipient('shangazi Wanjiku', contacts)
  assert.equal(r.status, 'did_you_mean')
  assert.deepEqual(r.candidates.map((c) => c.id), ['amina'])
  // negative controls: the full alias and the first name still resolve
  assert.equal(resolveRecipient('Amina Wanjiku', contacts).contact.id, 'amina')
  assert.equal(resolveRecipient('Juma', contacts).contact.id, 'juma')
  assert.equal(resolveRecipient('Juma Mwangi', contacts).contact.id, 'juma')
  assert.equal(resolveRecipient('Mwangi', contacts).status, 'did_you_mean')
})

test('shillings and mobile money are never sent as USDT', () => {
  assert.equal(fiatInText('Changia shilingi 1,000 kwa harusi'), 'shilingi')
  assert.equal(fiatInText('Nitumie elfu mbili kwa M-Pesa leo'), 'M-Pesa')
  assert.equal(fiatInText('nitumie 500 bob'), 'bob')
  assert.equal(fiatInText('Ksh.500 kwa Juma'), 'Ksh')
  // negative controls: an explicit USDT amount, a person called Bob, dollars (read as USDT on purpose)
  assert.equal(fiatInText('Tuma USDT 20 kwa Juma, ni kama shilingi 2,600'), null)
  assert.equal(fiatInText('Send 20 to Bob'), null)
  assert.equal(fiatInText('Tuma dola 20 kwa Juma'), null)
  // the model said USDT but the person said shillings
  const r = checkSend({ ...base, intent: intent(), transcript: 'Mtumie Juma shilingi 20 za mboga' })
  assert.equal(r.decision, 'blocked')
  assert.ok(codes(r).includes('unsupported_token'))
  assert.ok(!codes(r).includes('token_assumed'))
  assert.equal(checkSend({ ...base, intent: intent(), transcript: 'Mtumie Juma USDT 20 za mboga' }).decision, 'confirm')
})

test('the word USDT somewhere does not unlock a shilling amount', () => {
  // no USDT amount is named: the 50 is shillings
  const r = checkSend({ ...base, intent: intent({ amount: '50' }), transcript: 'Tuma USDT kwa Juma, sawa na shilingi 50' })
  assert.equal(r.decision, 'blocked')
  assert.ok(codes(r).includes('unsupported_token'))
  // an explicit USDT amount next to a shilling comparison is fine, but only for the USDT amount
  assert.notEqual(checkSend({ ...base, intent: intent({ amount: '50' }), transcript: 'Tuma USDT 50 kwa Juma, sawa na shilingi 6,500' }).decision, 'blocked')
  assert.ok(codes(checkSend({ ...base, intent: intent({ amount: '6500' }), transcript: 'Tuma USDT 50 kwa Juma, sawa na shilingi 6,500' })).includes('unsupported_token'))
  assert.equal(fiatInText('Tuma USDT ishirini kwa Juma, ni kama shilingi 2,600', '20'), null)
})

test('addresses: only whole addresses are read from text', () => {
  assert.deepEqual(extractAddresses(`tuma kwa ${ADDR}`), [ADDR])
  assert.deepEqual(extractAddresses(`ref${ADDR}`), [], 'glued to a word on the left')
  assert.deepEqual(extractAddresses(`ab${ADDR}`), [], 'tail of a longer hex string')
  assert.deepEqual(extractAddresses(`${ADDR}ab`), [], 'followed by more hex')
  assert.equal(checkMessage({ text: `Lipa kwa ref${ADDR}` }).addresses.length, 0)
  assert.equal(checkMessage({ text: `Lipa kwa ${ADDR}` }).addresses.length, 1)
})

test('scam rules: Swahili forms', () => {
  const risk = (t) => riskFromFlags(ruleFlags(t))
  // advance fee with an object infix ("ku-i-fungua" = to unlock IT), fee-before-prize, relative/boss + pressure
  assert.equal(risk('Akaunti yako imefungwa. Lipa 1,000 ili kuifungua leo.'), 'high')
  assert.equal(risk('Hongera, umeshinda simu! Lipa ada ya 30 upate zawadi yako.'), 'high')
  assert.equal(risk('Ni mimi shangazi, nimekamatwa na polisi. Tuma pesa haraka!'), 'high')
  assert.equal(risk('Huyu ni meneja wako. Usimwambie mtu yeyote, lipa sasa hivi.'), 'high')
  assert.equal(risk('Samahani nilikutumia USDT 80 kimakosa, nirudishie tafadhali.'), 'high')
  // negative controls: everyday requests that share words with those rules
  assert.ok(!ruleFlags('nikopeshe dola thelathini, nitarudisha Ijumaa').some((f) => f.id === 'wrong_send'))
  assert.ok(!ruleFlags('nisaidie elfu moja, nitakurudishia wiki ijayo').some((f) => f.id === 'wrong_send'))
  assert.ok(!ruleFlags('Mtumie binamu yangu Zawadi dola 25 za kitabu').some((f) => f.id === 'prize'))
  assert.equal(risk('Tuma ada ya shule ya mtoto leo, tafadhali'), 'none')
  assert.equal(risk('Please tuma 40 kwa my brother Baraka, yuko hospitali.'), 'none')
})

test('model-only flags stay low, even "high" kinds', () => {
  const m = mergeFlags([], ['wrong_send', 'unlock_fee', 'impersonation'])
  assert.ok(m.every((f) => f.severity === 'low'))
  assert.equal(riskFromFlags(m), 'low')
  assert.equal(checkMessage({ text: 'Lipa kodi ya nyumba kwa mwenye nyumba wiki hii.', modelFlags: ['wrong_send', 'impersonation'] }).risk, 'low')
  // positive control: a rule hit plus the model still reaches high
  assert.equal(riskFromFlags(mergeFlags(ruleFlags('Lipa ada ya usajili kwanza'), ['wrong_send'])), 'high')
})

test('Sheng amounts: thao = 1,000 and soo = 100 are read, and they are shillings, never USDT', () => {
  // the code's own number reader (used to cross-check the model) and the rewrite the model sees
  assert.deepEqual([...amountsInText('si unitumie thao moja tu')], ['1000'])
  assert.deepEqual([...amountsInText('nitumie soo tano za lunch')], ['500'])
  assert.deepEqual([...amountsInText('nipe thao mbili soo tano')], ['2500'])
  assert.deepEqual([...amountsInText('nipe thao')], ['1000'])
  assert.equal(normalizeNumbers('nitumie soo tano za lunch'), 'nitumie 500 za lunch')
  assert.equal(normalizeNumbers('si unitumie thao moja tu.'), 'si unitumie 1000 tu.')
  // negative controls: words that only contain the letters are not amounts
  for (const t of ['see you soon', 'nitakuona baadaye, sooo happy', 'thaonyesha picha']) assert.equal(amountsInText(t).size, 0, t)
  // a Sheng amount is a shilling amount: the payment is blocked as a local currency, never sent as USDT
  assert.equal(fiatInText('nitumie soo tano za lunch'), 'soo')
  const r = checkSend({ ...base, intent: intent({ amount: '500', token: null }), transcript: 'Juma nitumie soo tano za lunch' })
  assert.equal(r.decision, 'blocked')
  assert.ok(codes(r).includes('unsupported_token'))
  assert.ok(!codes(r).some((c) => c.startsWith('amount_')), 'the amount itself was heard (500)')
  // control: an explicit USDT amount next to a Sheng word is a USDT payment (and only that amount)
  assert.equal(fiatInText('Tuma USDT 20 kwa Juma, ni kama soo tano hivi', '20'), null)
  assert.notEqual(fiatInText('Tuma USDT 20 kwa Juma, ni kama soo tano hivi', '500'), null)
})
