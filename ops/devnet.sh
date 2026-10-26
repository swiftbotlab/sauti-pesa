#!/bin/bash
# Run the network side against a LOCAL test chain: anvil + bin/netsync.mjs share a private network namespace
# (no internet, no host services). Chain state persists in queue/devnet/anvil-state.json between runs.
# ops/sandbox.sh holds an exclusive lock on queue/devnet/ for the whole run (CLI and UI runs never overlap).
#   ops/devnet.sh devnet-setup | sync | broadcast | status | devnet-bump-nonce (tests)
set -euo pipefail
PROD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROD"
case "${1:-}" in devnet-setup|sync|broadcast|status|devnet-bump-nonce) ;; *) echo "usage: $0 devnet-setup|sync|broadcast|status|devnet-bump-nonce" >&2; exit 2 ;; esac
Q="${SAUTI_DATA:-.}/queue/devnet"
Q="${Q#"$PROD"/}"
[[ "$Q" =~ ^(\./queue/devnet|tmp(/[A-Za-z0-9_-][A-Za-z0-9._-]*){1,4}/queue/devnet)$ ]] || { echo "SAUTI_DATA must be tmp/<name>" >&2; exit 2; }
exec ops/sandbox.sh devnet /bin/bash -c '
  set -e
  /opt/foundry/anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --state "$2/anvil-state.json" --silent &
  A=$!
  for i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/8545) 2>/dev/null && break; sleep 0.1; done
  rc=0; node bin/netsync.mjs "$1" --network devnet || rc=$?
  kill -INT $A; wait $A 2>/dev/null || true
  exit $rc' devnet "$1" "$Q"
