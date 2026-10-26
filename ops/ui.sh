#!/bin/bash
# Start the local app: the resident ENGINE inside the offline sandbox (QVAC models + wallet, no network at all,
# Unix socket only) and the 127.0.0.1 bridge that serves the UI. Ctrl-C stops both.
#   ops/ui.sh        then open the printed link (SAUTI_UI_PORT to change the port)
# The link carries a random key in its #fragment, new at every start. The page sends it back in a header and
# the bridge refuses every API call without it, so other local users or programs that can reach 127.0.0.1
# cannot use the wallet. The key never goes into the sandbox. Treat the link like a password.
set -euo pipefail
PROD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROD"
. ops/lib.sh
# A caller that brings its own key (SAUTI_UI_TOKEN, e.g. the demo recorder) already knows it: then the link is
# printed without it, so the key does not end up in that caller's logs.
GIVEN="${SAUTI_UI_TOKEN:-}"
TOKEN="${GIVEN:-$(new_ui_token)}"
valid_ui_token "$TOKEN" || { echo "SAUTI_UI_TOKEN must be 32-128 URL-safe characters" >&2; exit 2; }
PORT="${SAUTI_UI_PORT:-8787}"
ENG=""; BR=""
cleanup () { [ -n "$BR" ] && kill "$BR" 2>/dev/null; [ -n "$ENG" ] && kill "$ENG" 2>/dev/null; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM
env -u SAUTI_UI_TOKEN ops/sandbox.sh offline node bin/serve.mjs &
ENG=$!
SAUTI_UI_TOKEN="$TOKEN" node bin/bridge.mjs &
BR=$!
if [ -n "$GIVEN" ]; then echo "UI: http://127.0.0.1:${PORT}/ (key from SAUTI_UI_TOKEN)"
else echo "Open this link (it holds this session's key; it changes at every start): http://127.0.0.1:${PORT}/#k=${TOKEN}"; fi
wait -n "$ENG" "$BR"
