#!/usr/bin/env node
// Start the resident engine (src/engine.js): QVAC models + wallet, local socket only, no network.
//   ops/sandbox.sh offline node bin/serve.mjs        (normally via ops/ui.sh)
//   npm run portable -- ui                           (a laptop without bubblewrap, network switched off)
// This launcher uses Node built-ins only. It refuses to continue unless it runs inside the offline sandbox (or the
// explicit portable mode) AND a live probe finds the internet unreachable (src/gate.js), and only then loads the
// engine and its dependencies (QVAC, WDK, ethers). So starting it by mistake on a connected host never executes
// third-party code there.
import { checkGate } from '../src/gate.js'

const g = await checkGate({ launcher: 'node bin/serve.mjs' })
if (!g.ok) {
  console.error(g.message)
  process.exit(2)
}
const { runEngine } = await import('../src/engine.js')
await runEngine()
