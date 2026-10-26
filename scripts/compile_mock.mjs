// Compile contracts/MockUSDT.sol with solc-js 0.8.28 (offline sandbox) -> data/MockUSDT.json
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import solc from 'solc'
const source = readFileSync('contracts/MockUSDT.sol', 'utf8')
const input = { language: 'Solidity', sources: { 'MockUSDT.sol': { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }
const out = JSON.parse(solc.compile(JSON.stringify(input)))
const errs = (out.errors || []).filter((e) => e.severity === 'error')
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1) }
const c = out.contracts['MockUSDT.sol'].MockUSDT
writeFileSync('data/MockUSDT.json', JSON.stringify({ compiler: solc.version(), source_sha256: createHash('sha256').update(source).digest('hex'), abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 1))
console.log('compiled', solc.version(), 'bytecode bytes', c.evm.bytecode.object.length / 2)
