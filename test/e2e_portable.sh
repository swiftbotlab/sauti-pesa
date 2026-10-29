#!/bin/bash
# End-to-end test of PORTABLE mode (bin/portable.mjs -> SAUTI_SANDBOX=portable), the run path for a laptop without
# bubblewrap. On this Linux box:
#   1. NEGATIVE controls on the host, whose network is ON: every portable entry point must refuse, clearly, and leave
#      nothing behind (no wallet, no socket, the demo folder untouched).
#   2. The same launcher in a NETWORK-LESS namespace. bwrap is used here ONLY to take the network away
#      (--dev-bind / /: the whole filesystem as it is, no masks, nothing read-only); the app sees
#      SAUTI_SANDBOX=portable, never "offline". The whole demo must pass (voice + text -> checks -> offline signature),
#      and the signatures are checked from the outbox alone (scripts/verify_outbox.mjs, plus a tampered copy).
#   3. The network "comes back" mid-run: a hosts entry makes the probe's DNS leg succeed, as a real network would.
#      The CLI must refuse to sign after it had started; the engine must refuse to sign and to run AI requests, and
#      its bridge must refuse every network action in portable mode.
#   test/e2e_portable.sh        (~3 min; the engine part needs ~3 GB RAM: stop ops/ui.sh and other engines first)
set -euo pipefail
cd "$(dirname "$0")/.."
PROD="$(pwd -P)"
. ops/lib.sh
OUT=tmp/e2e-portable
DEMO=tmp/portable-demo
pass=0; ok () { pass=$((pass + 1)); echo "  ok   $*"; }; fail () { echo "E2E FAIL: $*"; exit 1; }
unset SAUTI_SANDBOX SAUTI_DATA SAUTI_UI_TOKEN SAUTI_ENGINE_PIPE || true
# bwrap only removes the network (and, for part 3, swaps /etc/hosts for a copy the test can append to)
nonet () { bwrap --dev-bind / / --unshare-net --die-with-parent --chdir "$PROD" "$@"; }
nonet_hosts () { local h="$PROD/$OUT/hosts-$1"; shift; cp /etc/hosts "$h"; bwrap --dev-bind / / --bind "$h" /etc/hosts --unshare-net --die-with-parent --chdir "$PROD" "$@"; }
FLIP='127.0.0.1 huggingface.co'
REFUSE_FLIP='the internet is reachable from this computer (dns huggingface.co resolved). Turn Wi-Fi/Ethernet off, then run again.'

# ------------------------------------------------------------------ part 3 runs INSIDE the namespace (re-entered)
if [ "${1:-}" = --inside-cli ]; then
  export SAUTI_DATA=$DEMO
  rc=0; node bin/portable.mjs probe > "$OUT/c0.txt" 2>&1 || rc=$?
  [ $rc = 0 ] || fail "inside: probe not offline before the flip (rc $rc)"
  node bin/portable.mjs ask "Tuma USDT 7 kwa Juma" --yes > "$OUT/c1.txt" 2>&1 &
  P=$!
  for _ in $(seq 1 200); do grep -q 'network: OFF (verified: no route' "$OUT/c1.txt" && break; sleep 0.05; done
  grep -q 'network: OFF (verified: no route' "$OUT/c1.txt" || fail "inside: the CLI did not start"
  echo "$FLIP" >> /etc/hosts # the network "comes back" while the model loads
  rc=0; wait $P || rc=$?
  [ $rc = 1 ] && grep -qF "error: refusing to sign: $REFUSE_FLIP" "$OUT/c1.txt" || { cat "$OUT/c1.txt"; fail "inside: CLI did not refuse to sign (rc $rc)"; }
  grep -q 'Imesainiwa\|Signed on this device' "$OUT/c1.txt" && fail "inside: CLI signed with the network back"
  rc=0; node bin/portable.mjs probe > "$OUT/c2.txt" 2>&1 || rc=$?
  [ $rc = 3 ] && grep -q 'dns huggingface.co resolved' "$OUT/c2.txt" || fail "inside: probe control after the flip"
  exit 0
fi
if [ "${1:-}" = --inside-engine ]; then
  export SAUTI_DATA=$DEMO SAUTI_UI_PORT=8789
  S=$DEMO/run/engine.sock
  TOKEN="$(new_ui_token)"
  SAUTI_UI_TOKEN="$TOKEN" node bin/portable.mjs ui > "$OUT/ui.log" 2>&1 &
  L=$!
  KIDS=""
  # stop the launcher (it stops the engine and the bridge); anything of ours still alive after 30 s is killed
  stop_all () { kill $L 2>/dev/null; for _ in $(seq 1 60); do kill -0 $L 2>/dev/null || break; sleep 0.5; done; for k in $KIDS; do kill -9 "$k" 2>/dev/null || true; done; wait $L 2>/dev/null || true; }
  trap stop_all EXIT
  sleep 1; KIDS="$(pgrep -P $L | tr '\n' ' ')"
  for _ in $(seq 1 240); do curl -s --unix-socket "$S" http://e/v1/status 2>/dev/null | grep -q '"ready":true' && break; sleep 0.5; done
  curl -s --unix-socket "$S" http://e/v1/status > "$OUT/e0.json" || fail "inside: engine not reachable"
  grep -q '"ready":true' "$OUT/e0.json" && grep -q '"sandbox":"portable"' "$OUT/e0.json" && grep -q '"online":false' "$OUT/e0.json" || { tail -20 "$OUT/ui.log"; fail "inside: engine not ready in portable mode"; }
  post () { curl -s -o "$OUT/$1.json" -w '%{http_code}' --unix-socket "$S" -H 'content-type: application/json' -d "$2" "http://e$3"; }
  sid_of () { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["sid"])' "$OUT/$1.json"; }
  [ "$(post e1 '{"text":"Tuma USDT 5 kwa Juma","lang":"sw"}' /v1/ask)" = 200 ] || fail "inside: ask"
  [ "$(post e2 "{\"sid\":\"$(sid_of e1)\"}" /v1/confirm)" = 200 ] && grep -q '"queued"' "$OUT/e2.json" || fail "inside: engine did not sign offline"
  [ "$(post e3 '{"text":"Tuma USDT 6 kwa Juma","lang":"sw"}' /v1/ask)" = 200 ] || fail "inside: second ask"
  SID2="$(sid_of e3)"
  # the bridge in portable mode: the page's key + origin, and still no network action
  c=$(curl -s -o "$OUT/b1.json" -w '%{http_code}' -H "x-sauti-key: $TOKEN" -H 'origin: http://127.0.0.1:8789' -H 'content-type: application/json' -d '{"network":"devnet"}' http://127.0.0.1:8789/api/net/broadcast)
  [ "$c" = 409 ] && grep -q 'portable mode never goes online' "$OUT/b1.json" || fail "inside: bridge broadcast not refused ($c)"
  c=$(curl -s -o "$OUT/b2.json" -w '%{http_code}' -H "x-sauti-key: $TOKEN" -H 'origin: http://127.0.0.1:8789' -H 'content-type: application/json' -d '{"network":"sepolia"}' http://127.0.0.1:8789/api/net/sync)
  [ "$c" = 409 ] || fail "inside: bridge sync not refused ($c)"
  for p in $(pgrep -f '[b]in/serve.mjs' || true); do
    tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qF "$TOKEN" && fail "inside: UI key in the engine's environment"
  done
  grep -qF "$TOKEN" "$OUT/ui.log" && fail "inside: UI key in the log"
  echo "$FLIP" >> /etc/hosts # the network "comes back"
  [ "$(post e4 "{\"sid\":\"$SID2\"}" /v1/confirm)" = 423 ] && grep -qF "refusing to sign: $REFUSE_FLIP" "$OUT/e4.json" || { cat "$OUT/e4.json"; fail "inside: engine signed with the network back"; }
  [ "$(post e5 '{"text":"Tuma USDT 8 kwa Juma","lang":"sw"}' /v1/ask)" = 423 ] && grep -qF "refusing to run this request: $REFUSE_FLIP" "$OUT/e5.json" || fail "inside: engine ran an AI request with the network back"
  c=$(curl -s -o "$OUT/b3.json" -w '%{http_code}' -H "x-sauti-key: $TOKEN" http://127.0.0.1:8789/api/status)
  [ "$c" = 200 ] && grep -q '"online":true' "$OUT/b3.json" || fail "inside: status pill should now say network ON"
  exit 0
fi

# ------------------------------------------------------------------ part 1: negative controls, network ON
rm -rf "$OUT" && mkdir -p "$OUT"
echo "1. negative controls on this host (network ON)"
rc=0; node bin/portable.mjs probe > "$OUT/n0.txt" 2>&1 || rc=$?
[ $rc = 3 ] && grep -q '^network: ON' "$OUT/n0.txt" || fail "control: this test needs a host that is ONLINE (probe rc $rc)"
ok "control: the probe sees this host online ($(grep -o 'reachable from this computer ([^)]*)' "$OUT/n0.txt"))"
mkdir -p "$DEMO" && echo keep > "$DEMO/marker"
expect_refusal () { # label, output file, command...
  local label="$1" f="$OUT/$2" rc=0; shift 2
  "$@" > "$f" 2>&1 || rc=$?
  [ "$rc" = 2 ] || { cat "$f"; fail "$label: exit $rc, expected 2"; }
  grep -q '^refusing to start: the internet is reachable from this computer (' "$f" && grep -qF 'Turn Wi-Fi/Ethernet off, then run again.' "$f" \
    || { cat "$f"; fail "$label: no clear refusal"; }
  ok "$label refuses: $(head -c 150 "$f")…"
}
expect_refusal "npm run portable -- demo" n1.txt npm run -s portable -- demo
[ -f "$DEMO/marker" ] || fail "the refused demo touched $DEMO"
expect_refusal "portable wallet init" n2.txt env SAUTI_DATA=$OUT/data node bin/portable.mjs wallet init
[ ! -e "$OUT/data/private/wallet.json" ] || fail "a wallet was created while online"
expect_refusal "portable ask" n3.txt env SAUTI_DATA=$OUT/data node bin/portable.mjs ask "Tuma USDT ishirini kwa Amina" --yes
expect_refusal "portable ui" n4.txt env SAUTI_DATA=$OUT/data node bin/portable.mjs ui
[ ! -e "$OUT/data/run/engine.sock" ] || fail "an engine socket exists"
expect_refusal "ops/portable.sh say" n5.txt env SAUTI_DATA=$OUT/data ops/portable.sh say test/audio/sw_amina_20.wav --yes
expect_refusal "CLI with SAUTI_SANDBOX=portable set by hand" n6.txt env SAUTI_SANDBOX=portable SAUTI_DATA=$OUT/data node bin/sauti.mjs ask "Tuma USDT ishirini kwa Amina" --yes
expect_refusal "engine with SAUTI_SANDBOX=portable set by hand" n7.txt env SAUTI_SANDBOX=portable SAUTI_DATA=$OUT/data node bin/serve.mjs
[ ! -e "$OUT/data/private/wallet.json" ] && [ ! -e "$OUT/data/run/engine.sock" ] || fail "something was created while online"
rc=0; node bin/sauti.mjs queue > "$OUT/n8.txt" 2>&1 || rc=$?
[ $rc = 2 ] && grep -q '^refusing to start: run it inside the offline sandbox' "$OUT/n8.txt" || fail "CLI without a mode"
ok "CLI without a mode refuses as before: $(head -c 100 "$OUT/n8.txt")…"

# ------------------------------------------------------------------ part 2: the same launcher with no network
echo "2. portable launcher in a network-less namespace (the app sees SAUTI_SANDBOX=portable)"
rc=0; nonet node bin/portable.mjs probe > "$OUT/p0.txt" 2>&1 || rc=$?
[ $rc = 0 ] && grep -q '^network: OFF' "$OUT/p0.txt" || fail "probe in the namespace (rc $rc)"
ok "probe: $(tail -1 "$OUT/p0.txt")"
rc=0; nonet npm run -s portable -- demo > "$OUT/p1.txt" 2>&1 || rc=$?
sed -n '/^ok   1\./,$p' "$OUT/p1.txt" | sed 's/^/       /'
[ $rc = 0 ] && grep -q '^PORTABLE DEMO PASS' "$OUT/p1.txt" || { tail -40 "$OUT/p1.txt"; fail "portable demo (rc $rc)"; }
grep -q 'sandbox: portable' "$OUT/p1.txt" && ! grep -q 'sandbox: offline' "$OUT/p1.txt" || fail "the app did not run in portable mode"
[ "$(grep -c '^\[network: OFF (verified: no route, no DNS) | sandbox: portable' "$OUT/p1.txt")" -ge 8 ] || fail "network header missing"
grep -q 'Checks (6, plain code)\|Ukaguzi (6, plain code)' "$OUT/p1.txt" || fail "six-check line missing"
ok "demo: Swahili text + English voice note signed offline, look-alike blocked, no-amount refused, scam SMS high risk"
grep -m1 'Ukaguzi (6' "$OUT/p1.txt" | sed 's/^ */       /'
SAUTI_DATA=$DEMO node scripts/verify_outbox.mjs --network devnet --expect 2 > "$OUT/p2.txt" || { cat "$OUT/p2.txt"; fail "signature check"; }
ok "outbox signatures: $(tail -1 "$OUT/p2.txt")"
# positive control for the signature check: a copy with one amount changed must fail
rm -rf "$OUT/tamper" && mkdir -p "$OUT/tamper/queue" && cp -r "$DEMO/queue/devnet" "$OUT/tamper/queue/"
python3 -I -c 'import json,sys,glob; f=sorted(glob.glob(sys.argv[1]+"/tx-*.json"))[0]; d=json.load(open(f)); d["amountUnits"]=str(int(d["amountUnits"])*10); json.dump(d,open(f,"w"))' "$OUT/tamper/queue/devnet"
if SAUTI_DATA=$OUT/tamper node scripts/verify_outbox.mjs --network devnet > "$OUT/p3.txt"; then fail "control: a tampered record passed"; fi
grep -q 'PROBLEMS: amount' "$OUT/p3.txt" || fail "control: tamper not named"
ok "control: a record with a changed amount fails the signature check"

# ------------------------------------------------------------------ part 3: the network comes back mid-run
echo "3. the network comes back while it runs (DNS leg of the probe succeeds)"
nonet_hosts cli /bin/bash test/e2e_portable.sh --inside-cli || fail "CLI part"
ok "CLI: started offline, network back before signing -> $(grep -o 'error: refusing to sign: .*' "$OUT/c1.txt" | head -c 120)…"
ok "CLI: nothing signed; probe control after the flip: $(tail -1 "$OUT/c2.txt" | head -c 90)…"
nonet_hosts engine /bin/bash test/e2e_portable.sh --inside-engine || { tail -30 "$OUT/ui.log"; fail "engine part"; }
ok "engine (portable, real models): text request -> checks -> signed offline over its socket"
ok "bridge (portable): broadcast and sync refused with 409; UI key not in the engine's environment or the log"
ok "engine: network back -> confirm refused (423: $(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["error"][:60])' "$OUT/e4.json")…), AI request refused, status shows network ON"
SAUTI_DATA=$DEMO node scripts/verify_outbox.mjs --network devnet --expect 3 > "$OUT/p4.txt" || { cat "$OUT/p4.txt"; fail "after part 3"; }
ok "outbox after part 3: $(tail -1 "$OUT/p4.txt") (2 demo + 1 engine; the refused ones never signed)"
[ ! -e "$DEMO/run/engine.sock" ] || fail "engine socket left behind"
echo "E2E PORTABLE PASS ($pass checks)"
