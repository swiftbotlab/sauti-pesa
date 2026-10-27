#!/bin/bash
# Download the models listed in models.json ONCE (setup mode, network on), then verify sha256 + size.
# Only curl runs with the network; no third-party package code is executed during download.
# The sha256 values come from QVAC's own model registry (@qvac/inference models.js), and the files are
# fetched from their Hugging Face origin at the exact commit QVAC pins.
#   scripts/fetch_models.sh QWEN3_1_7B_INST_Q4 WHISPER_SMALL_Q8_0 VAD_SILERO_5_1_2
set -euo pipefail
PROD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROD"
mkdir -p models
for KEY in "$@"; do
  # OCR weights exist only in QVAC's own peer-to-peer registry (no Hugging Face origin): fenced fetch, same checks
  if python3 -I -c 'import json,sys; sys.exit(0 if "registry" in json.load(open("models.json"))[sys.argv[1]] else 1)' "$KEY"; then
    scripts/fetch_registry_model.sh "$KEY"; continue
  fi
  read -r FILE URL SHA BYTES < <(python3 -I -c '
import json,sys
m=json.load(open("models.json"))[sys.argv[1]]
assert m["url"].startswith("https://huggingface.co/"), "unexpected host"
assert "/" not in m["file"] and not m["file"].startswith(".")
print(m["file"], m["url"], m["sha256"], m["bytes"])' "$KEY")
  OUT="models/$FILE"
  if [ -f "$OUT" ] && [ "$(stat -c %s "$OUT")" = "$BYTES" ] && echo "$SHA  $OUT" | sha256sum -c --status; then
    echo "$KEY: already present and verified"; continue
  fi
  echo "$KEY: downloading $BYTES bytes"
  ops/sandbox.sh setup /usr/bin/curl -sS -L --fail --proto '=https' --max-filesize 3000000000 \
      --retry 3 -C - -o "$OUT.part" "$URL"
  SIZE=$(stat -c %s "$OUT.part")
  [ "$SIZE" = "$BYTES" ] || { echo "$KEY: size $SIZE != $BYTES" >&2; exit 1; }
  echo "$SHA  $OUT.part" | sha256sum -c --status || { echo "$KEY: sha256 mismatch" >&2; exit 1; }
  mv "$OUT.part" "$OUT"; chmod 444 "$OUT"
  echo "$KEY: ok sha256=$SHA"
done
