#!/usr/bin/env node
// Sauti Pesa CLI - the OFFLINE side:
//   ops/sandbox.sh offline node bin/sauti.mjs <command> ...      (commands: see src/cli.mjs, or run it without one)
// This launcher uses Node built-ins only. Like bin/serve.mjs, it refuses to continue unless it runs inside the
// offline sandbox AND the internet is unreachable, and only then loads the CLI and its dependencies (QVAC, WDK,
// ethers). So running it by mistake on a connected host never executes third-party code there.
import { networkProof } from '../src/offline.js'

if (process.env.SAUTI_SANDBOX !== 'offline') {
  console.error('refusing to start: run it inside the offline sandbox (ops/sandbox.sh offline node bin/sauti.mjs ...)')
  process.exit(2)
}
const p = await networkProof()
if (p.online) {
  console.error('refusing to start: the internet is reachable from this process')
  process.exit(2)
}
await import('../src/cli.mjs')
