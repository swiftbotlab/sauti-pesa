// Decode a signed raw transaction (display + the broadcast-time integrity check). ethers only, no WDK,
// so the network side (bin/netsync.mjs) never loads wallet code.
import { Interface, Transaction, getAddress } from 'ethers'

const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])

export function describeRaw (raw) {
  const t = Transaction.from(raw)
  let transfer = null
  try { const d = ERC20.decodeFunctionData('transfer', t.data); transfer = { to: getAddress(d[0]), amountUnits: d[1].toString() } } catch {}
  return { hash: t.hash, from: t.from, to: t.to, nonce: t.nonce, chainId: Number(t.chainId), gasLimit: t.gasLimit.toString(), maxFeePerGas: t.maxFeePerGas?.toString(), transfer }
}
