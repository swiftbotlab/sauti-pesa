#!/usr/bin/env node
// Sauti Pesa CLI - the OFFLINE side:
//   ops/sandbox.sh offline node bin/sauti.mjs <command> ...      (commands: see src/cli.mjs, or run it without one)
//   npm run portable -- <command> ...                            (a laptop without bubblewrap, network switched off)
// This launcher uses Node built-ins only. Like bin/serve.mjs, it refuses to continue unless it runs inside the
// offline sandbox (or the explicit portable mode) AND a live probe finds the internet unreachable (src/gate.js),
// and only then loads the CLI and its dependencies (QVAC, WDK, ethers). So running it by mistake on a connected
// host never executes third-party code there.
import { checkGate } from '../src/gate.js'

const g = await checkGate({ launcher: 'node bin/sauti.mjs ...' })
if (!g.ok) {
  console.error(g.message)
  process.exit(2)
}
await import('../src/cli.mjs')
