// NETWORK CODE. The only module in the project that opens connections. It is small on purpose so it can be
// read in one sitting: plain JSON-RPC over fetch to an allow-listed test-network endpoint. It never sees the
// seed (signing happened earlier, offline) and is never used by the AI side.
const MAX_RESPONSE = 1_000_000

// Read a response body, but stop (and abort the connection) as soon as it passes the cap: a hostile or broken
// endpoint cannot make this process buffer more than MAX_RESPONSE bytes.
async function readCapped (r, stop, max = MAX_RESPONSE) {
  if (Number(r.headers.get('content-length') || 0) > max) { stop.abort(); throw new Error('RPC response too large') }
  if (!r.body) return ''
  const reader = r.body.getReader()
  const chunks = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) { stop.abort(); try { await reader.cancel() } catch {} throw new Error('RPC response too large') }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export class Rpc {
  /** @param {string[]} urls allow-listed endpoints for ONE test network */
  constructor (urls, { timeoutMs = 15000 } = {}) {
    this.urls = urls.map((u) => {
      const x = new URL(u)
      const loopback = x.hostname === '127.0.0.1' && x.protocol === 'http:'
      if (x.protocol !== 'https:' && !loopback) throw new Error(`refusing non-https RPC ${x.origin}`)
      if (x.username || x.password) throw new Error('credentials in RPC URL are not allowed')
      return x.href
    })
    this.timeoutMs = timeoutMs
    this.id = 0
  }

  async call (method, params = []) {
    let lastErr
    for (const url of this.urls) {
      const stop = new AbortController()
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          redirect: 'error',
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(this.timeoutMs)])
        })
        const text = await readCapped(r, stop)
        const j = JSON.parse(text)
        if (j.error) { const e = new Error(`${method}: ${String(j.error.message).slice(0, 200)}`); e.rpc = true; throw e }
        return j.result
      } catch (e) {
        if (e.rpc) throw e // a real answer from the node; do not retry elsewhere
        lastErr = e
      }
    }
    // Transport failure on every endpoint: the caller cannot know whether the node acted on the request.
    const e = new Error(`all RPC endpoints failed for ${method}: ${lastErr?.cause?.code || lastErr?.message}`)
    e.transport = true
    throw e
  }

  chainId = async () => Number(BigInt(await this.call('eth_chainId')))
  nonce = async (addr) => Number(BigInt(await this.call('eth_getTransactionCount', [addr, 'pending'])))
  confirmedNonce = async (addr) => Number(BigInt(await this.call('eth_getTransactionCount', [addr, 'latest'])))
  nativeBalance = async (addr) => BigInt(await this.call('eth_getBalance', [addr, 'latest']))
  tokenBalance = async (token, addr) => BigInt(await this.call('eth_call', [{ to: token, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, 'latest']))
  sendRaw = (raw) => this.call('eth_sendRawTransaction', [raw])
  receipt = (hash) => this.call('eth_getTransactionReceipt', [hash])
  txByHash = (hash) => this.call('eth_getTransactionByHash', [hash])

  async fees () {
    const block = await this.call('eth_getBlockByNumber', ['latest', false])
    const base = BigInt(block.baseFeePerGas || '0x0')
    let tip = 1_000_000_000n
    try { tip = BigInt(await this.call('eth_maxPriorityFeePerGas')) } catch {}
    return { baseFee: base, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip }
  }

  async estimateTransferGas (from, token, to, amountUnits) {
    const data = '0xa9059cbb' + to.slice(2).toLowerCase().padStart(64, '0') + BigInt(amountUnits).toString(16).padStart(64, '0')
    return BigInt(await this.call('eth_estimateGas', [{ from, to: token, data }]))
  }
}
