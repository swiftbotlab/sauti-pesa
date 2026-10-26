#!/bin/bash
# End-to-end test of the UI/API path: real offline engine + 127.0.0.1 bridge + local devnet, throwaway wallet.
#   test/e2e_ui.sh          (stop ops/ui.sh first: the engine needs ~3 GB RAM)
set -euo pipefail
cd "$(dirname "$0")/.."
. ops/lib.sh
export SAUTI_DATA=tmp/e2e-ui SAUTI_UI_PORT=8788
SAUTI_UI_TOKEN="$(new_ui_token)"; export SAUTI_UI_TOKEN # for the bridge and the test client only
rm -rf tmp/e2e-ui && mkdir -p tmp/e2e-ui
ops/sandbox.sh offline node bin/sauti.mjs wallet init --require-offline >/dev/null
ops/sandbox.sh offline node bin/sauti.mjs contacts demo >/dev/null
ops/devnet.sh devnet-setup
# negative controls: the launchers refuse outside the offline sandbox and when the internet is reachable
if env -u SAUTI_UI_TOKEN node bin/serve.mjs >tmp/e2e-ui/host1.txt 2>&1; then echo "E2E FAIL: engine started on the host"; exit 1; fi
if env -u SAUTI_UI_TOKEN SAUTI_SANDBOX=offline node bin/serve.mjs >tmp/e2e-ui/host2.txt 2>&1; then echo "E2E FAIL: engine started with the internet on"; exit 1; fi
if env -u SAUTI_UI_TOKEN SAUTI_SANDBOX=offline node bin/sauti.mjs queue >tmp/e2e-ui/host3.txt 2>&1; then echo "E2E FAIL: CLI ran with the internet on"; exit 1; fi
if env -u SAUTI_UI_TOKEN node bin/bridge.mjs >tmp/e2e-ui/host4.txt 2>&1; then echo "E2E FAIL: bridge started without a UI key"; exit 1; fi
grep -q 'refusing to start' tmp/e2e-ui/host1.txt && grep -q 'internet is reachable' tmp/e2e-ui/host2.txt && grep -q 'internet is reachable' tmp/e2e-ui/host3.txt \
  && grep -q 'no UI key' tmp/e2e-ui/host4.txt && echo "  ok   engine + CLI refuse on the host / with network; bridge refuses without a UI key"
# a voice note left behind by a killed engine must be gone after the next start
mkdir -p tmp/e2e-ui/run/uploads && echo stale > tmp/e2e-ui/run/uploads/left-over.wav
env -u SAUTI_UI_TOKEN ops/sandbox.sh offline node bin/serve.mjs >tmp/e2e-ui/engine.log 2>&1 &
ENG=$!
node bin/bridge.mjs >tmp/e2e-ui/bridge.log 2>&1 &
BR=$!
trap 'kill $BR $ENG 2>/dev/null; wait 2>/dev/null || true' EXIT
node test/e2e_ui.mjs
[ ! -e tmp/e2e-ui/run/uploads/left-over.wav ] && echo "  ok   left-over upload removed at engine start" || { echo "E2E FAIL: left-over upload still there"; exit 1; }
# the UI key never reaches the sandboxed engine and is never logged
for p in $(pgrep -f '[n]ode bin/serve.mjs' || true); do
  if tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qF "$SAUTI_UI_TOKEN"; then echo "E2E FAIL: UI key in the environment of engine process $p"; exit 1; fi
done
if grep -rqF "$SAUTI_UI_TOKEN" tmp/e2e-ui/*.log; then echo "E2E FAIL: UI key in a log"; exit 1; fi
echo "  ok   UI key not in the engine's environment, not in any log"
