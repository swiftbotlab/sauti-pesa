#!/bin/bash
# End-to-end test with the internet OFF (bwrap --unshare-net), using a throwaway wallet under tmp/e2e.
# Real models, real WDK signing, then broadcast on the local devnet (its own network namespace).
#   test/e2e_offline.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export SAUTI_DATA=tmp/e2e
rm -rf tmp/e2e && mkdir -p tmp/e2e
run () { ops/sandbox.sh offline node bin/sauti.mjs "$@" --require-offline; }
fail () { echo "E2E FAIL: $*"; exit 1; }
POISON=$(python3 -I -c "import json;print(json.load(open('data/demo-attack.json'))['poisoned_amina'])")

run wallet init | tee tmp/e2e/01.txt
grep -q 'network: OFF' tmp/e2e/01.txt || fail "network was not off"
run contacts demo >/dev/null
# one sync while "online" (here: the local test chain in its own namespace), then everything else offline
ops/devnet.sh devnet-setup

run ask "Tuma USDT ishirini kwa Amina kwa ajili ya kodi" --yes | tee tmp/e2e/02.txt
grep -q 'Imesainiwa kwenye kifaa' tmp/e2e/02.txt || fail "Swahili text request was not signed+queued"

run say test/audio/en_brother_15.wav --lang en --yes | tee tmp/e2e/03.txt
grep -q 'Signed on this device (offline) and queued' tmp/e2e/03.txt || fail "English voice request was not signed+queued"

run ask "send 10 USDT to $POISON for rent" --yes | tee tmp/e2e/04.txt
grep -q 'address-poisoning' tmp/e2e/04.txt || fail "look-alike address was not blocked"
grep -q 'queued' tmp/e2e/04.txt && fail "look-alike payment was queued"

run ask "tuma kwa Otieno" --yes | tee tmp/e2e/05.txt
grep -q 'Signed\|Imesainiwa' tmp/e2e/05.txt && fail "payment without an amount was signed"

run check "Umeshinda zawadi ya USDT 500! Lipa ada ya usajili 20 USDT ndani ya saa 1 ili kupokea." | tee tmp/e2e/06.txt
grep -q 'HATARI KUBWA' tmp/e2e/06.txt || fail "scam SMS not rated high risk"

[ "$(ops/sandbox.sh offline node bin/sauti.mjs queue | grep -c '^queued')" = 2 ] || fail "expected 2 queued payments"

# network back: broadcast the queue on the local chain (still no internet)
ops/devnet.sh broadcast | tee tmp/e2e/07.txt
[ "$(grep -c 'confirmed in block' tmp/e2e/07.txt)" = 2 ] || fail "expected 2 confirmed transfers"
grep -q 'USDT 965' tmp/e2e/07.txt || fail "balance after 20 + 15 USDT should be 965"
echo "E2E PASS"
