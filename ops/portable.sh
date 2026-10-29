#!/bin/sh
# Convenience wrapper for the portable launcher (POSIX shells; on Windows use `npm run portable -- <command>`):
#   ops/portable.sh probe | demo | ui | wallet init | contacts demo | ask "..." | say file.wav | check "..." | queue
# Portable mode is for a laptop WITHOUT bubblewrap, with the network switched off. On Linux with bubblewrap the
# sandbox (ops/sandbox.sh offline ..., ops/ui.sh) stays the default. Details: bin/portable.mjs, JUDGES.md.
set -eu
PROD="$(cd "$(dirname "$0")/.." && pwd -P)"
exec node "$PROD/bin/portable.mjs" "$@"
