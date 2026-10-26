#!/bin/bash
# Eval over the private commissioned Swahili test set (see scripts/eval_sw_requests.mjs) with a throwaway wallet
# (tmp/eval-sw-requests) and the resident engine. Skips cleanly (exit 0) when the set is not in test/data/private/.
#   scripts/eval_sw_requests.sh        (stop ops/ui.sh first: the engine needs ~3 GB RAM)
# Writes tmp/eval-sw-requests/results.json (full, local only) and test/data/eval_sw_requests_results.json (outcomes
# only, no text from the set).
set -euo pipefail
cd "$(dirname "$0")/.."
. ops/lib.sh
if [ ! -f test/data/private/sw_requests_commissioned.md ] || [ ! -f test/data/private/sw_requests_commissioned.labels.json ]; then
  echo "skipped: the private test set is not in test/data/private/ (the numbers in README.md were measured with it)"; exit 0
fi
export SAUTI_DATA=tmp/eval-sw-requests SAUTI_UI_PORT=8790
SAUTI_UI_TOKEN="$(new_ui_token)"; export SAUTI_UI_TOKEN
rm -rf tmp/eval-sw-requests && mkdir -p tmp/eval-sw-requests
ops/sandbox.sh offline node bin/sauti.mjs wallet init --require-offline >/dev/null
ops/sandbox.sh offline node bin/sauti.mjs contacts demo >/dev/null
ops/devnet.sh devnet-setup
env -u SAUTI_UI_TOKEN ops/sandbox.sh offline node bin/serve.mjs > tmp/eval-sw-requests/engine.log 2>&1 &
ENG=$!
node bin/bridge.mjs > tmp/eval-sw-requests/bridge.log 2>&1 &
BR=$!
trap 'kill $BR $ENG 2>/dev/null; wait 2>/dev/null || true' EXIT
until grep -q "ready:" tmp/eval-sw-requests/engine.log; do sleep 0.3; if grep -q "failed" tmp/eval-sw-requests/engine.log; then cat tmp/eval-sw-requests/engine.log; exit 1; fi; done
node scripts/eval_sw_requests.mjs tmp/eval-sw-requests --public test/data/eval_sw_requests_results.json > tmp/eval-sw-requests/run.log
python3 -I -c "import json; print(json.dumps(json.load(open('tmp/eval-sw-requests/results.json'))['summary'], indent=1))"
