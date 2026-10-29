#!/bin/bash
# Eval over the private commissioned Swahili test set (see scripts/eval_sw_requests.mjs) with a throwaway wallet
# (tmp/eval-sw-requests) and the resident engine. Skips cleanly (exit 0) when the set is not in test/data/private/.
#   scripts/eval_sw_requests.sh        (stop ops/ui.sh first: the engine needs ~3 GB RAM)
# Writes tmp/eval-sw-requests/results.json (full, local only) and test/data/eval_sw_requests_results.json (outcomes
# only, no text from the set).
set -euo pipefail
cd "$(dirname "$0")/.."
. ops/lib.sh
# Default = the private commissioned set. Judges: run the PUBLIC set with
#   SAUTI_EVAL_SET=test/data/public/sw_requests_public.md SAUTI_EVAL_LABELS=test/data/public/sw_requests_public.labels.json scripts/eval_sw_requests.sh
EVAL_SET="${SAUTI_EVAL_SET:-test/data/private/sw_requests_commissioned.md}"
EVAL_LABELS="${SAUTI_EVAL_LABELS:-test/data/private/sw_requests_commissioned.labels.json}"
if [ ! -f "$EVAL_SET" ] || [ ! -f "$EVAL_LABELS" ]; then
  echo "skipped: test set not found ($EVAL_SET / $EVAL_LABELS). The private set is not redistributed; use the public set (test/data/public/)."; exit 0
fi
export SAUTI_EVAL_SET="$EVAL_SET" SAUTI_EVAL_LABELS="$EVAL_LABELS"
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
RESULTS_OUT=test/data/eval_sw_requests_results.json
[ "$EVAL_SET" != "test/data/private/sw_requests_commissioned.md" ] && RESULTS_OUT=test/data/public/eval_sw_requests_public_results.json
# SAUTI_PROFILE=lite (Qwen3-0.6B for intent, src/profile.js): the same run, results in a separate *_lite.json
case "${SAUTI_PROFILE:-}" in ''|default) ;; lite) RESULTS_OUT="${RESULTS_OUT%.json}_lite.json" ;; *) echo "SAUTI_PROFILE must be default or lite" >&2; exit 2 ;; esac
node scripts/eval_sw_requests.mjs tmp/eval-sw-requests --public "$RESULTS_OUT" > tmp/eval-sw-requests/run.log
python3 -I -c "import json; print(json.dumps(json.load(open('tmp/eval-sw-requests/results.json'))['summary'], indent=1))"
