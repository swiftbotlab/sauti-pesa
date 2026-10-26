// Outbox of signed-but-not-yet-broadcast payments, plus the cached chain state from the last sync.
// Everything here is public-ish data (signed transactions, nonces, balances); the seed never comes here.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export class Store {
  constructor (root, networkId) {
    this.dir = join(root, networkId)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  _write (name, obj) {
    const f = join(this.dir, name)
    writeFileSync(`${f}.tmp`, JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1), { mode: 0o600 })
    renameSync(`${f}.tmp`, f)
  }

  _read (name, fallback = null) {
    const f = join(this.dir, name)
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback
  }

  state () { return this._read('state.json', {}) }
  saveState (patch) { const s = { ...this.state(), ...patch }; this._write('state.json', s); return s }

  list () {
    return readdirSync(this.dir).filter((f) => /^tx-[0-9a-f-]{36}\.json$/.test(f)).map((f) => this._read(f)).sort((a, b) => a.nonce - b.nonce || a.created.localeCompare(b.created))
  }

  add (entry) {
    const id = randomUUID()
    const e = { id, status: 'queued', created: new Date().toISOString(), ...entry }
    this._write(`tx-${id}.json`, e)
    return e
  }

  update (id, patch) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad id')
    const e = { ...this._read(`tx-${id}.json`), ...patch, updated: new Date().toISOString() }
    this._write(`tx-${id}.json`, e)
    return e
  }

  /** Payments in the rolling day window for limits (queued, broadcast and confirmed count). */
  history () {
    return this.list().filter((e) => e.status !== 'failed' && e.status !== 'cancelled').map((e) => ({ to: e.to, amountUnits: e.amountUnits, at: e.created, status: e.status }))
  }

  /** Next nonce to use offline: after the chain's last known nonce and after anything already queued. */
  nextNonce () {
    const s = this.state()
    const pending = this.list().filter((e) => ['queued', 'broadcast'].includes(e.status)).map((e) => e.nonce + 1)
    return Math.max(Number.isInteger(s.nonce) ? s.nonce : 0, ...pending)
  }
}
