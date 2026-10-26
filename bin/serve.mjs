#!/usr/bin/env node
// Start the resident engine (src/engine.js): QVAC models + wallet, Unix socket only, no network.
//   ops/sandbox.sh offline node bin/serve.mjs        (normally via ops/ui.sh)
// This launcher uses Node built-ins only. It refuses to continue unless it runs inside the offline sandbox
// AND the internet is unreachable, and only then loads the engine and its dependencies (QVAC, WDK, ethers).
// So starting it by mistake on a connected host never executes third-party code there.
import { networkProof } from '../src/offline.js'

const p = await networkProof()
if (process.env.SAUTI_SANDBOX !== 'offline') {
  console.error('refusing to start: run it inside the offline sandbox (ops/sandbox.sh offline node bin/serve.mjs)')
  process.exit(2)
}
if (p.online) {
  console.error('refusing to start: the internet is reachable from this process')
  process.exit(2)
}
const { runEngine } = await import('../src/engine.js')
await runEngine()
