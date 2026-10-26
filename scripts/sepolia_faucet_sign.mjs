// Dev helper: sign (OFFLINE) one call to the public Aave v3 Sepolia testnet faucet that mints test USDT to
// our own test wallet. WDK is given a policy that allows exactly this call and nothing else.
//   ops/sandbox.sh offline node scripts/sepolia_faucet_sign.mjs <nonce> <maxFeeGwei>
//   ops/sandbox.sh online node bin/netsync.mjs faucet-mint --network sepolia
import { writeFileSync, readFileSync } from 'node:fs'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { Interface, getAddress, keccak256 } from 'ethers'
import { NETWORKS } from '../src/networks.js'

// gas: eth_estimateGas says ~155k (a first try with 120k ran out of gas, tx 0xc539ee46...)
const FAUCET = '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D' // Aave v3 testnet faucet (isPermissioned() == false, checked)
const TOKEN = NETWORKS.sepolia.token.address
const AMOUNT = 1000n * 10n ** 6n
const iface = new Interface(['function mint(address token, address to, uint256 amount) returns (uint256)'])
const [nonce, maxFeeGwei] = [Number(process.argv[2] || 0), BigInt(process.argv[3] || 5)]

const { seed } = JSON.parse(readFileSync('private/wallet.json', 'utf8'))
let me = null
const wdk = new WDK(seed).registerWallet('sepolia', WalletManagerEvm, { chainId: 11155111 }).registerPolicy({
  id: 'faucet-mint-only', name: 'only the test-USDT faucet mint to myself', scope: 'project', wallet: 'sepolia',
  rules: [
    { name: 'reads', operation: '*', action: 'ALLOW', conditions: [() => true] },
    {
      name: 'only-faucet-mint', operation: ['signTransaction', 'sendTransaction', 'transfer', 'approve', 'sign', 'signTypedData'], action: 'DENY',
      conditions: [({ args, operation }) => {
        if (operation !== 'signTransaction') return true
        try {
          const tx = args[0]; const d = iface.decodeFunctionData('mint', tx.data)
          return !(getAddress(tx.to) === FAUCET && getAddress(d[0]) === TOKEN && getAddress(d[1]) === me && d[2] <= 10000n * 10n ** 6n && BigInt(tx.value) === 0n)
        } catch { return true }
      }]
    }
  ]
})
const acct = await wdk.getAccount('sepolia', 0)
me = await acct.getAddress()
const raw = await acct.signTransaction({
  type: 2, chainId: 11155111, to: FAUCET, value: 0n, nonce,
  data: iface.encodeFunctionData('mint', [TOKEN, me, AMOUNT]),
  gasLimit: 200000n, maxFeePerGas: maxFeeGwei * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n
})
writeFileSync('queue/sepolia/faucet-mint.raw', raw, { mode: 0o600 })
console.log(`signed faucet mint of 1000 test USDT to ${me}, nonce ${nonce}, tx ${keccak256(raw)}`)
