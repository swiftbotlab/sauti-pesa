#!/bin/bash
# One offline QVAC profiler run over the app's AI code paths (speech to text + VAD, intent LLM, OCR) ->
# evidence/qvac-profile.json (read it with evidence/README.md). The measuring itself is scripts/profile_qvac.mjs,
# run in the OFFLINE sandbox (own empty network namespace). This wrapper only:
#   1. drops our own model files from the page cache first (posix_fadvise DONTNEED, no root; the same step as
#      scripts/mem_cap_run.sh), so the first load of each model reads its weights from disk, as after a reboot;
#   2. adds what the sandbox cannot see (no /sys inside): the CPU name from lscpu and the machine type;
#   3. copies the result to evidence/.
#   scripts/profile_qvac.sh          about 2 minutes; stop ops/ui.sh first (RAM)
#   scripts/profile_qvac.sh --keep   leave evidence/ as it is (result only in tmp/profile/qvac-profile.json)
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP=0; [ "${1:-}" = --keep ] && KEEP=1
OUT=tmp/profile
mkdir -p "$OUT"
EVICTED=$(python3 -I -c '
import os, sys
n = 0
for p in sys.argv[1:]:
    if os.path.isfile(p) and not os.path.islink(p):
        fd = os.open(p, os.O_RDONLY)
        try: os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED); n += 1
        finally: os.close(fd)
print(n)' models/*)
echo "page cache: dropped $EVICTED model files"
ops/sandbox.sh offline node scripts/profile_qvac.mjs "$OUT/qvac-profile.json" | tee "$OUT/run.log"
python3 -I - "$OUT/qvac-profile.json" "$EVICTED" <<'PY'
import json, pathlib, subprocess, sys
p = pathlib.Path(sys.argv[1])
d = json.loads(p.read_text())
def read(f):
    try:
        return pathlib.Path(f).read_text().strip() or None
    except OSError:
        return None
lscpu = {}
try:
    out = subprocess.run(['lscpu'], capture_output=True, text=True, timeout=10).stdout
    for line in out.splitlines():
        k, _, v = line.partition(':')
        if k.strip() in ('Architecture', 'CPU(s)', 'Vendor ID', 'Model name', 'Core(s) per cluster', 'Thread(s) per core', 'Flags'):
            lscpu[k.strip()] = v.strip()
except (OSError, subprocess.SubprocessError):
    pass
try:
    virt = subprocess.run(['systemd-detect-virt'], capture_output=True, text=True, timeout=10).stdout.strip() or None
except (OSError, subprocess.SubprocessError):
    virt = None
d['hardware']['host'] = {
    'lscpu': lscpu,
    'machine': ' '.join(x for x in (read('/sys/class/dmi/id/sys_vendor'), read('/sys/class/dmi/id/product_name')) if x) or None,
    'virtualization': virt,
}
d['run_conditions'] = {
    'page_cache': f'{sys.argv[2]} model files dropped from the page cache before the run: the first load of each model read its weights from disk',
    'machine_shared': 'the machine also runs other services; numbers are from one run, not an average of many',
}
p.write_text(json.dumps(d, indent=1, ensure_ascii=False) + '\n')
print(f"host facts added: {lscpu.get('Vendor ID')} / {lscpu.get('Model name')} / {d['hardware']['host']['machine']}")
PY
if [ $KEEP = 0 ]; then
  mkdir -p evidence
  cp "$OUT/qvac-profile.json" evidence/qvac-profile.json
  echo "copied to evidence/qvac-profile.json ($(wc -c < evidence/qvac-profile.json) bytes)"
fi
