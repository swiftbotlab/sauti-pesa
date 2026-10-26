#!/bin/bash
# Record the demo video from REAL runs: the terminal proof (termcast.py, which also starts ops/ui.sh), the UI run
# (record_ui.py: separate headless Chrome, fake microphone fed with a synthetic test clip), then make_video.py.
#   scripts/demo/make_demo.sh rehearsal   throwaway wallet in tmp/rehearsal, local devnet, port 8789
#   scripts/demo/make_demo.sh final       the Sepolia TEST wallet in private/, port 8787 (broadcasts on Sepolia)
# Stop ops/ui.sh first (RAM: the engine needs ~3 GB).
set -euo pipefail
cd "$(dirname "$0")/../.."
# machine-local settings (ops/local.env, not in git, parsed by ops/lib.sh): SAUTI_PY (python with Pillow +
# websocket-client), SAUTI_TTS_DIR, SAUTI_VIDEO_TOOL
. ops/lib.sh
load_local_env "$(pwd -P)"
export SAUTI_TTS_DIR="${SAUTI_TTS_DIR:-}" SAUTI_VIDEO_TOOL="${SAUTI_VIDEO_TOOL:-}"
# one UI key for this recording: ops/ui.sh (started by termcast.py) and the recorder both get it
SAUTI_UI_TOKEN="$(new_ui_token)"; export SAUTI_UI_TOKEN
PY="${SAUTI_PY:-python3}"
MODE=${1:?usage: make_demo.sh rehearsal|final}
case "$MODE" in
  rehearsal)
    export SAUTI_DATA=tmp/rehearsal SAUTI_UI_PORT=8789; NET=devnet; OUT=tmp/demo/rehearsal
    rm -rf tmp/rehearsal && mkdir -p tmp/rehearsal
    ops/sandbox.sh offline node bin/sauti.mjs wallet init --require-offline >/dev/null
    ops/sandbox.sh offline node bin/sauti.mjs contacts demo >/dev/null
    ops/devnet.sh devnet-setup ;;
  final)
    unset SAUTI_DATA; export SAUTI_UI_PORT=8787; NET=sepolia; OUT=tmp/demo/final
    # one sync while online (nonce, fees, balances), like a phone that was online this morning
    ops/sandbox.sh online node bin/netsync.mjs sync --network sepolia ;;
  *) echo "usage: make_demo.sh rehearsal|final" >&2; exit 2 ;;
esac
if pgrep -f '[b]in/serve.mjs' >/dev/null; then echo "an engine is already running; stop it first" >&2; exit 2; fi
rm -rf "$OUT" && mkdir -p "$OUT/term" "$OUT/ui"
rm -f tmp/demo/ui.pid
stop_ui () {
  # tmp/ is writable from the offline sandbox: only signal the process group if the pid really is our ops/ui.sh
  if [ -f tmp/demo/ui.pid ]; then
    local pid; pid="$(head -c 16 tmp/demo/ui.pid | tr -cd '0-9')"
    if [ -n "$pid" ] && [ "$pid" -gt 1 ] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q '^/bin/bash ops/ui.sh \|^ops/ui.sh \|bash ops/ui.sh '; then
      kill -TERM -- "-$pid" 2>/dev/null || true
    fi
    rm -f tmp/demo/ui.pid
  fi
}
trap stop_ui EXIT
date -u +"%FT%TZ terminal take" | tee "$OUT/log.txt"
$PY -I scripts/demo/termcast.py scripts/demo/term_steps.json "$OUT/term/term.mp4" --events "$OUT/term/events.json" | tee -a "$OUT/log.txt"
cp tmp/demo/ui.log "$OUT/term/ui.log"
date -u +"%FT%TZ UI take ($NET)" | tee -a "$OUT/log.txt"
$PY -I scripts/demo/record_ui.py --out "$OUT/ui" --network "$NET" --port "$SAUTI_UI_PORT" --abort-slow "${SAUTI_ABORT_SLOW:-0}" | tee -a "$OUT/log.txt"
[ "${PIPESTATUS[0]}" = 0 ] || { echo "UI take failed or aborted" | tee -a "$OUT/log.txt"; exit 3; }
cp tmp/demo/ui.log "$OUT/ui/engine_bridge.log"
stop_ui
date -u +"%FT%TZ assemble" | tee -a "$OUT/log.txt"
VID=media/sauti-pesa-demo.mp4
[ "$MODE" = rehearsal ] && VID=$OUT/sauti-pesa-demo-rehearsal.mp4
$PY -I scripts/demo/make_video.py --term "$OUT/term" --ui "$OUT/ui" --out "$VID" --work "$OUT/video" | tee -a "$OUT/log.txt"
