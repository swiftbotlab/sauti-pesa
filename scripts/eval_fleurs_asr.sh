#!/bin/bash
# Speech to text on REAL human voices: 40 clips of Google FLEURS, Swahili (Kenya) test split, read by native speakers.
# FLEURS: Conneau et al. 2022, https://huggingface.co/datasets/google/fleurs, licence CC-BY 4.0.
#
#   scripts/eval_fleurs_asr.sh            # the model the app ships (Whisper small q8_0)
#   scripts/eval_fleurs_asr.sh both       # + the CLI's optional `--accurate` model (large-v3-turbo q5_0), for comparison
#   scripts/eval_fleurs_asr.sh both nogain   # the same with the app's input level normalization (src/gain.js) OFF:
#                                            # the app as it was before it had one -> fleurs_results_before_gain.json
#
# 1. Downloads test.tsv (276 KB) and audio/test.tar.gz (333 MB) from the FLEURS repo at a PINNED commit, https only,
#    and checks both against pinned hashes (the archive's sha256 is Hugging Face's own LFS oid).
# 2. scripts/fleurs_prepare.py picks 40 clips deterministically and extracts ONLY those (the archive is untrusted data:
#    whitelisted names, regular files, size cap), converting FLEURS' 32-bit float WAV to the 16-bit PCM WAV the app
#    accepts with the app recorder's own formula (ui/app.js encodeWav; nothing else changed); then the archive is deleted.
# 3. Runs the app's own speech code (src/asr.js) with internet OFF in the sandbox: scripts/eval_fleurs_asr.mjs.
# 4. Writes test/data/public/fleurs_results.json (numbers + reference/transcript text, no audio; with a `before_gain`
#    summary taken from fleurs_results_before_gain.json when that file exists) and deletes the audio.
# Everything downloaded lives in tmp/fleurs/ (git-ignored). FLEURS_KEEP=1 keeps the archive and clips.
# Needs ~1.5 GB free RAM for small, ~2.5 GB for turbo (one model loaded at a time).
set -euo pipefail
cd "$(dirname "$0")/.."
WHICH="${1:-small}"
case "$WHICH" in small) RUNS=(small) ;; both) RUNS=(small turbo) ;; turbo) RUNS=(turbo) ;; *) echo "usage: $0 [small|both|turbo] [nogain]" >&2; exit 2 ;; esac
GAIN="${2:-}"
case "$GAIN" in "") SUF=""; OUT=test/data/public/fleurs_results.json ;; nogain) SUF="-nogain"; OUT=test/data/public/fleurs_results_before_gain.json ;; *) echo "usage: $0 [small|both|turbo] [nogain]" >&2; exit 2 ;; esac

REV=70bb2e84b976b7e960aa89f1c648e09c59f894dd # google/fleurs commit (2026-05-15)
BASE="https://huggingface.co/datasets/google/fleurs/resolve/$REV/data/sw_ke"
TSV_SHA256=74218f52a1f930dcf92cba7367e87cba753b47bc0661c05e22b5e631b4c9cf6c   # = git blob fcfb3f69d05bfaee730f0182e96c362421515dc7
TSV_BYTES=276161
TAR_SHA256=8f893fd1f8ab0e53022297a0a89de0454a8a94fcd50c8d2d8784e3dc3261570f   # Hugging Face LFS oid
TAR_BYTES=333019109
COUNT=40
D=tmp/fleurs
mkdir -p "$D"
[ "$(realpath -m "$D")" = "$PWD/$D" ] || { echo "$D must not be a symlink" >&2; exit 2; }

fetch () { # url out sha256 bytes
  local url="$1" out="$2" sha="$3" bytes="$4"
  if [ -f "$out" ] && [ ! -L "$out" ] && [ "$(stat -c %s "$out")" = "$bytes" ] && echo "$sha  $out" | sha256sum -c --status; then
    echo "$(basename "$out"): present, sha256 ok"; return
  fi
  echo "$(basename "$out"): downloading $bytes bytes"
  /usr/bin/curl -sS -L --fail --proto '=https' --proto-redir '=https' --max-filesize "$((bytes + 1))" \
      --retry 3 -C - -o "$out.part" "$url"
  [ "$(stat -c %s "$out.part")" = "$bytes" ] || { echo "$(basename "$out"): wrong size" >&2; exit 1; }
  echo "$sha  $out.part" | sha256sum -c --status || { echo "$(basename "$out"): sha256 mismatch" >&2; exit 1; }
  mv "$out.part" "$out"
}

if [ -f "$D/selected.json" ] && grep -q '"audio_conversion"' "$D/selected.json" && [ -d "$D/clips" ] && [ "$(find "$D/clips" -maxdepth 1 -name '*.wav' -type f | wc -l)" = "$COUNT" ]; then
  echo "clips: already extracted"
else
  fetch "$BASE/test.tsv" "$D/test.tsv" "$TSV_SHA256" "$TSV_BYTES"
  fetch "$BASE/audio/test.tar.gz" "$D/test.tar.gz" "$TAR_SHA256" "$TAR_BYTES"
  rm -rf "$D/clips"
  python3 -I scripts/fleurs_prepare.py "$D/test.tsv" "$D/test.tar.gz" "$D" "$COUNT"
  [ "${FLEURS_KEEP:-}" = 1 ] || rm -f "$D/test.tar.gz"
fi

for M in "${RUNS[@]}"; do
  NEED=1500; [ "$M" = turbo ] && NEED=2500
  AVAIL=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
  [ "$AVAIL" -ge "$NEED" ] || { echo "only $AVAIL MB RAM available, $M needs ~$NEED MB; stop other work first" >&2; exit 1; }
  echo "running $M${SUF} ($AVAIL MB available), internet off"
  ops/sandbox.sh offline node scripts/eval_fleurs_asr.mjs "$D" "$M" $GAIN 2> "$D/run_$M$SUF.log"
done

# one public file: dataset + attribution, then each run (numbers, per-clip reference and transcript text, no audio)
python3 -I - "$D" "$OUT" "$REV" "$TSV_SHA256" "$TAR_SHA256" "$SUF" "${RUNS[@]}" <<'PY'
import json, sys, os
d, dst, rev, tsv_sha, tar_sha, suf, *runs = sys.argv[1:]
sel = json.load(open(os.path.join(d, 'selected.json'), encoding='utf-8'))
out = {
  'dataset': {
    'name': 'FLEURS (Few-shot Learning Evaluation of Universal Representations of Speech), Swahili (Kenya) sw_ke, test split',
    'source': 'https://huggingface.co/datasets/google/fleurs', 'revision': rev,
    'files': {'data/sw_ke/test.tsv': tsv_sha, 'data/sw_ke/audio/test.tar.gz': tar_sha},
    'license': 'CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/)',
    'attribution': 'Google, FLEURS. Conneau et al., "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech", 2022 (arXiv:2205.12446). Reference texts below are the FLEURS "transcription" column; no audio is redistributed here.',
    'what_it_is': 'read speech: FLoRes sentences (from Wikinews, Wikijunior and Wikivoyage) read aloud by native speakers; not phone-quality street audio, not payment requests',
  },
  'selection': {k: sel[k] for k in ('rule', 'rows', 'bad_rows', 'distinct_ids', 'ids_skipped_over_30s_before_count_reached')},
  'audio_conversion': sel['audio_conversion'],
  'normalizer': 'both sides: Unicode NFKC, lower case, apostrophes removed, every other non-letter/non-digit -> space, spaces collapsed (scripts/asr_score.mjs). No number-word or spelling normalization.',
  'measures': 'speech-to-text step only (raw transcript), not intent or payment parsing',
  'input_gain': ('on: the app as it runs now (src/gain.js before VAD/ASR)' if not suf else
                 'OFF: the app before it had input level normalization (kept for comparison)'),
  'runs': [json.load(open(os.path.join(d, f'results_{m}{suf}.json'), encoding='utf-8')) for m in runs],
}
before = os.path.join(os.path.dirname(dst), 'fleurs_results_before_gain.json')
if not suf and os.path.isfile(before) and not os.path.islink(before):
  b = json.load(open(before, encoding='utf-8'))
  keep = ('clips', 'wer', 'cer', 'median_clip_wer', 'median_clip_cer', 'wer_breakdown', 'clips_with_wer_over_0_5', 'latency_ms')
  out['before_gain'] = {
    'note': 'the same clips, model and settings with the input level normalization OFF (the app before it had one); per-clip data: fleurs_results_before_gain.json',
    'runs': [{'model': r['run']['model'], 'at': r['run']['at'], **{k: r['summary'][k] for k in keep},
              'empty_transcripts': r['summary']['subsets']['empty_transcripts']} for r in b['runs']],
  }
tmp = dst + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
  json.dump(out, f, ensure_ascii=False, indent=1); f.write('\n')
os.replace(tmp, dst)
for r in out['runs']:
  s = r['summary']
  print(f"{r['run']['model']}{suf}: {s['clips']} clips, WER {s['wer']}, CER {s['cer']}, median clip WER {s['median_clip_wer']}, latency median {s['latency_ms']['median']} ms (max {s['latency_ms']['max']}), median RTF {s['median_rtf']}")
PY
[ "${FLEURS_KEEP:-}" = 1 ] || rm -rf "$D/clips"
echo "wrote $OUT"
