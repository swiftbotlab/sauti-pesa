#!/bin/bash
# "Check a message" from a SCREENSHOT, end to end with the internet OFF (offline sandbox), real models:
# QVAC OCR reads each test screenshot, then the same checks as pasted text (rules, look-alike addresses, and the
# on-device language model's second opinion) give the verdict, compared with test/data/public/screens/labels.json.
# --require-offline: the CLI refuses to run if the internet is reachable (bin/sauti.mjs also refuses outside the
# offline sandbox). Throwaway data under tmp/e2e_ocr (demo contacts only, no wallet needed).
#   test/e2e_ocr.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export SAUTI_DATA=tmp/e2e_ocr
rm -rf tmp/e2e_ocr && mkdir -p tmp/e2e_ocr
fail () { echo "E2E OCR FAIL: $*"; exit 1; }
for m in models/latin_g2.gguf models/craft_mlt_25k.gguf; do
  [ -f "$m" ] || fail "$m missing: run scripts/fetch_models.sh OCR_LATIN OCR_CRAFT (once, online)"
done
ops/sandbox.sh offline node bin/sauti.mjs contacts demo --require-offline >/dev/null

N=0
for f in $(python3 -I -c 'import json; print(" ".join(sorted(json.load(open("test/data/public/screens/labels.json"))["screens"])))'); do
  ops/sandbox.sh offline node bin/sauti.mjs check --image "test/data/public/screens/$f" --json --require-offline > "tmp/e2e_ocr/$f.out" \
    || fail "$f: the check command failed"
  python3 -I - "$f" "tmp/e2e_ocr/$f.out" <<'EOF' || fail "$f: verdict differs from labels.json"
import json, sys
name, out = sys.argv[1], sys.argv[2]
want = json.load(open('test/data/public/screens/labels.json'))['screens'][name]
r = json.loads(open(out).read().strip().splitlines()[-1])
rank = {'none': 0, 'low': 1, 'medium': 2, 'high': 3}
rules = [f['id'] for f in r['flags'] if f['source'] == 'rule']
look = [l['name'] for a in r['addresses'] for l in a['looksLike']]
ok = (r['risk'] == want['risk']) if 'risk' in want else (rank[r['risk']] <= rank[want['risk_max']])
ok = ok and all(x in rules for x in want['rule_flags']) and look == ([want['lookalike_of']] if want['lookalike_of'] else [])
ok = ok and r['lang'] == want['lang'] and r.get('ocrText')
t = r['timing']
print(f"{name}: risk={r['risk']} rules={rules} lookalike={look} ocr={t['ocr_ms']} ms (load {t['ocr_load_ms']} ms) llm={t['llm_ms']} ms -> {'ok' if ok else 'MISMATCH'}")
sys.exit(0 if ok else 1)
EOF
  N=$((N + 1))
done
[ "$N" = 4 ] || fail "expected 4 screenshots, checked $N"

# content check: a file that is not a PNG/JPEG is refused before OCR, whatever its name
cp test/audio/sw_juma_15.wav tmp/e2e_ocr/not_an_image.png
if ops/sandbox.sh offline node bin/sauti.mjs check --image tmp/e2e_ocr/not_an_image.png --require-offline > tmp/e2e_ocr/bad.out 2>&1; then
  fail "a WAV file named .png was accepted"
fi
grep -q 'PNG or JPEG' tmp/e2e_ocr/bad.out || fail "wrong error for a non-image: $(tail -1 tmp/e2e_ocr/bad.out)"
echo "E2E OCR PASS ($N screenshots + non-image refused)"
