// WDK wallet tests: offline signing + the WDK policy that only signs what the person confirmed.
// Uses a throwaway wallet in tmp/, never private/.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createWallet, openWallet, describeRaw } from '../src/wallet.js'

const dir = mkdtempSync(fileURLToPath(new URL('../tmp/wtest-', import.meta.url)))
const file = `${dir}/wallet.json`
after(() => rmSync(dir, { recursive: true, force: true }))

const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const fees = { nonce: 0, gasLimit: 70000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }

test('create wallet: 600 permissions, no overwrite', async () => {
  const addr = await createWallet(file)
  assert.match(addr, /^0x[0-9a-fA-F]{40}$/)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  await assert.rejects(createWallet(file), /refusing to overwrite/)
})

test('WDK refuses to sign without a confirmation', async () => {
  const w = await openWallet(file, { chainId: 31337 })
  await assert.rejects(w.signTransfer({ token: TOKEN, to: TO, amountUnits: 20_000_000n, ...fees }), /WDK policy refused/)
  w.dispose()
})

test('confirmed transfer signs offline and decodes back exactly', async () => {
  const w = await openWallet(file, { chainId: 31337 })
  w.approve({ token: TOKEN, to: TO, amountUnits: 20_000_000n })
  const s = await w.signTransfer({ token: TOKEN, to: TO, amountUnits: 20_000_000n, ...fees })
  const d = describeRaw(s.raw)
  assert.equal(d.hash, s.hash)
  assert.equal(d.from, await w.address())
  assert.equal(d.to, TOKEN)
  assert.deepEqual(d.transfer, { to: TO, amountUnits: '20000000' })
  assert.equal(d.chainId, 31337)
  // one confirmation = one signature
  await assert.rejects(w.signTransfer({ token: TOKEN, to: TO, amountUnits: 20_000_000n, ...fees, nonce: 1 }), /WDK policy refused/)
  w.dispose()
})

test('policy blocks a different amount, recipient, chain or a fee above the cap', async () => {
  const w = await openWallet(file, { chainId: 31337, maxFeeWei: 10n ** 15n })
  const tries = [
    { amountUnits: 21_000_000n },
    { to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
    { maxFeePerGas: 10n ** 12n } // 70000 * 1e12 = 7e16 wei > 1e15 cap
  ]
  for (const t of tries) {
    w.approve({ token: TOKEN, to: TO, amountUnits: 20_000_000n })
    await assert.rejects(w.signTransfer({ token: TOKEN, to: TO, amountUnits: 20_000_000n, ...fees, ...t }), /WDK policy refused/, JSON.stringify(t, (k, v) => typeof v === 'bigint' ? v.toString() : v))
  }
  w.approve({ token: TOKEN, to: TO, amountUnits: 20_000_000n })
  await assert.rejects(w.signRaw({ to: TO, value: 10n ** 18n, chainId: 31337, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 2 }), (e) => e.name === 'PolicyViolationError')
  await assert.rejects(w.signMessage('hello'), (e) => e.name === 'PolicyViolationError')
  w.dispose()
  const other = await openWallet(file, { chainId: 11155111 })
  other.approve({ token: TOKEN, to: TO, amountUnits: 20_000_000n })
  const s = await other.signTransfer({ token: TOKEN, to: TO, amountUnits: 20_000_000n, ...fees })
  assert.equal(describeRaw(s.raw).chainId, 11155111)
  other.dispose()
})

test('a corrupted wallet file gives a generic error that quotes nothing from the file', async () => {
  const bad = `${dir}/corrupt.json`
  // looks like a half-written seed file: the parse error must not echo these words
  writeFileSync(bad, 'seed: zebra canyon ostrich lantern', { mode: 0o600 })
  const err = await openWallet(bad, { chainId: 31337 }).then(() => null, (e) => e)
  assert.ok(err, 'must refuse')
  assert.equal(err.message, 'wallet file corrupted')
  // control: JSON.parse itself does quote the input, which is what this guards against
  let parseMsg = ''
  try { JSON.parse(readFileSync(bad, 'utf8')) } catch (e) { parseMsg = e.message }
  assert.match(parseMsg, /zebr/)
  writeFileSync(bad, '{"seed": 42}', { mode: 0o600 })
  await assert.rejects(openWallet(bad, { chainId: 31337 }), /^Error: wallet file corrupted$/)
})
