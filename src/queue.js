// Outbox of signed-but-not-yet-broadcast payments, plus the cached chain state from the last sync.
// Everything here is public-ish data (signed transactions, nonces, balances); the seed never comes here.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const CLAIM_KEY = /^(0x[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/ // tx hash or signId (UUID)

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

  /** One entry, read fresh from disk (null if there is none). */
  get (id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) return null
    return this._read(`tx-${id}.json`)
  }

  /**
   * Decide ONCE, atomically, what happens to one signature of a payment: handed to the network ("send") or
   * cancelled on this device ("cancel"). The key is the signature's own id (entry.signId, new at every signing;
   * the tx hash for entries signed before signIds existed): signatures are deterministic, so a payment signed
   * again with the same nonce and fees can have the same hash as a cancelled one and must still be sendable.
   * The first caller creates claim-<key>.json exclusively (O_EXCL); every later caller gets the existing decision. The broadcaster claims "send" right before it gives the bytes to a node, and
   * a cancel claims "cancel" before it touches the entry, so a cancelled transaction is never sent and a sent
   * one is never shown as cancelled, even if the CLI and the broadcaster run at the same moment.
   * @returns {{ ok: boolean, by: 'send'|'cancel', at: string }} ok: this call made the decision
   */
  claim (key, by) {
    if (!CLAIM_KEY.test(String(key))) throw new Error('bad claim key')
    if (!['send', 'cancel'].includes(by)) throw new Error('bad claim')
    const f = join(this.dir, `claim-${key}.json`)
    const c = { by, at: new Date().toISOString() }
    try {
      writeFileSync(f, JSON.stringify(c), { mode: 0o600, flag: 'wx' })
      return { ok: true, ...c }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      return { ok: false, ...this.claimOf(key) }
    }
  }

  /** The decision for one signature, or null if none was made yet. */
  claimOf (key) {
    if (!CLAIM_KEY.test(String(key))) return null
    const f = join(this.dir, `claim-${key}.json`)
    if (!existsSync(f)) return null
    if (!lstatSync(f).isFile()) return { by: 'send', at: null } // anything odd counts as "already handed to the network"
    try {
      const c = JSON.parse(readFileSync(f, 'utf8'))
      return { by: c.by === 'cancel' ? 'cancel' : 'send', at: typeof c.at === 'string' ? c.at : null }
    } catch { return { by: 'send', at: null } }
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
