// Test networks only. There is deliberately no mainnet entry: this build cannot sign for real money.
export const NETWORKS = {
  // Local throwaway chain (anvil) inside the devnet sandbox; reproducible for judges, no faucet needed.
  devnet: {
    name: 'Local devnet (anvil)',
    chainId: 31337,
    rpc: ['http://127.0.0.1:8545'],
    // MockUSDT is the first contract deployed by anvil's dev account 0 (nonce 0), so its address is fixed
    token: { symbol: 'USDT', decimals: 6, address: '0x5FbDB2315678afecb367f032d93F642f64180aa3' },
    explorer: null,
    nativeSymbol: 'ETH (devnet)'
  },
  // Ethereum Sepolia testnet. Test USDT (6 decimals) from the Aave v3 testnet faucet, listed by the
  // WDK docs under "Testnet Funds & Faucets". Checked on-chain 2026-10-26: symbol USDT, decimals 6.
  sepolia: {
    name: 'Ethereum Sepolia (testnet)',
    chainId: 11155111,
    rpc: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'],
    token: { symbol: 'USDT', decimals: 6, address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' },
    // Blockscout (open-source explorer): loads without a bot challenge, also from a plain fetch
    explorer: 'https://eth-sepolia.blockscout.com/tx/',
    nativeSymbol: 'SepoliaETH'
  }
}

export function network (id) {
  const n = NETWORKS[id]
  if (!n) throw new Error(`unknown network "${id}" (use: ${Object.keys(NETWORKS).join(', ')})`)
  return n
}
