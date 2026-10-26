#!/bin/bash
# Before/after latency. BEFORE = phase-1 path: one CLI process per request (models load every time, full
# prompt prefill). AFTER = resident engine (models stay loaded, prompt prefix in QVAC's KV cache) via the bridge.
# Uses the throwaway data of test/e2e_ui.sh (tmp/e2e-ui); nothing is confirmed or broadcast.
#   scripts/bench_latency.sh      (stop ops/ui.sh first: RAM)
set -euo pipefail
cd "$(dirname "$0")/.."
. ops/lib.sh
export SAUTI_DATA=tmp/e2e-ui SAUTI_UI_PORT=8788
SAUTI_UI_TOKEN="$(new_ui_token)"; export SAUTI_UI_TOKEN
[ -f tmp/e2e-ui/private/wallet.json ] || { echo "run test/e2e_ui.sh first"; exit 2; }
OUT=tmp/bench_latency; mkdir -p $OUT
wall () { local t0; t0=$(date +%s%N); "$@" > /dev/null 2>&1 < /dev/null; echo $(( ($(date +%s%N) - t0) / 1000000 )); }
echo "BEFORE: one CLI process per request (wall clock, ms)" | tee $OUT/summary.txt
for f in sw_juma_15:sw en_otieno_40:en sw_amina_20:sw; do
  echo "  say ${f%%:*}: $(wall ops/sandbox.sh offline node bin/sauti.mjs say test/audio/${f%%:*}.wav --lang ${f##*:} --json)" | tee -a $OUT/summary.txt
done
for q in "Tuma USDT ishirini kwa Amina kwa ajili ya kodi" "Please send 40 USDT to Otieno for the rent." "pay my landlord 75 usdt"; do
  echo "  ask \"$q\": $(wall ops/sandbox.sh offline node bin/sauti.mjs ask "$q" --json)" | tee -a $OUT/summary.txt
done
echo "AFTER: resident engine" | tee -a $OUT/summary.txt
t0=$(date +%s%N)
env -u SAUTI_UI_TOKEN ops/sandbox.sh offline node bin/serve.mjs > $OUT/engine.log 2>&1 &
ENG=$!
node bin/bridge.mjs > $OUT/bridge.log 2>&1 &
BR=$!
trap 'kill $BR $ENG 2>/dev/null; wait 2>/dev/null || true' EXIT
until grep -q "ready:" $OUT/engine.log; do sleep 0.2; grep -q "failed" $OUT/engine.log && exit 1; done
echo "  engine start to ready (one time): $(( ($(date +%s%N) - t0) / 1000000 )) ms  ($(grep -o 'ready:.*' $OUT/engine.log))" | tee -a $OUT/summary.txt
node scripts/bench_engine.mjs > $OUT/engine.jsonl
tail -1 $OUT/engine.jsonl | tee -a $OUT/summary.txt
