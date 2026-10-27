#!/bin/bash
# Run a command under a HARD memory cap (cgroup v2, via a transient systemd user scope; swap off for the scope),
# then print the cgroup's own peak memory and OOM events. Evidence for "runs in N GB", not a sandbox.
#   scripts/mem_cap_run.sh 3G test/e2e_offline.sh
#   scripts/mem_cap_run.sh --check 3G        positive control: 2 GB fits, 3.5 GB must be killed (cap enforced)
# Refuses (exit 3) when the cap would not be enforced (memory controller not delegated to the user manager).
# Page cache is charged to the cgroup that first reads a file, so the model files are first evicted from the page
# cache (posix_fadvise DONTNEED on models/*, our own files only, no root): the capped run must read the weights
# itself and they count against the cap. memory.peak counts everything charged to the cgroup (anonymous memory +
# page cache of the memory-mapped weights, which the kernel can reclaim under the cap); a sampler also reports the
# highest anonymous and file-backed amounts seen (memory.stat, every 0.25 s).
set -euo pipefail
cd "$(dirname "$0")/.."
CHECK=0; [ "${1:-}" = --check ] && { CHECK=1; shift; }
LIMIT="${1:-}"; [[ "$LIMIT" =~ ^[0-9]{1,5}[MG]$ ]] || { echo "usage: $0 [--check] 3G <command...>" >&2; exit 2; }
shift
command -v systemd-run >/dev/null || { echo "needs systemd-run (systemd user session)" >&2; exit 3; }

inner='
  CG=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
  MAX=$(cat "$CG/memory.max" 2>/dev/null || echo missing); SWAP=$(cat "$CG/memory.swap.max" 2>/dev/null || echo missing)
  echo "[memcap] cgroup memory.max=$MAX bytes, memory.swap.max=$SWAP"
  [[ "$MAX" =~ ^[0-9]+$ ]] || { echo "[memcap] the memory cap is NOT enforced here; refusing to report a capped run" >&2; exit 3; }
  S=$(mktemp "$PWD/tmp/memcap.XXXXXX"); ( while :; do awk "/^(anon|file) /{printf \"%s %d \", \$1, \$2/1048576} END{print \"\"}" "$CG/memory.stat"; sleep 0.25; done ) > "$S" 2>/dev/null &
  SP=$!
  set +e; "$@"; RC=$?
  kill $SP 2>/dev/null; wait $SP 2>/dev/null
  PEAKS=$(awk "{for(i=1;i<NF;i+=2) if(\$(i+1)>m[\$i]) m[\$i]=\$(i+1)} END{printf \"max anon %d MB, max file %d MB\", m[\"anon\"], m[\"file\"]}" "$S"); rm -f "$S"
  echo "[memcap] exit=$RC memory.peak=$(( $(cat "$CG/memory.peak") / 1048576 )) MB ($PEAKS), $(grep -E "^oom(_kill)? " "$CG/memory.events" | tr "\n" " ")"
  exit $RC'

# evict our model files from the page cache (see above); files still mapped by a running process stay cached
evict () {
  python3 -I -c '
import os, sys
n = 0
for f in sys.argv[1:]:
    if os.path.isfile(f) and not os.path.islink(f):
        fd = os.open(f, os.O_RDONLY)
        try: os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED); n += 1
        finally: os.close(fd)
print(f"[memcap] page cache: evicted {n} model files (they now count against the cap when read)")' models/*
}

if [ $CHECK = 1 ]; then
  alloc='import sys; n=int(sys.argv[1])<<20; b=bytearray(n); b[::4096]=b"\x01"*len(range(0,n,4096)); print("allocated", sys.argv[1], "MB")'
  systemd-run --user --scope --quiet -p MemoryMax="$LIMIT" -p MemorySwapMax=0 bash -c "$inner" memcap python3 -I -c "$alloc" 2000 \
    || { echo "[memcap] check FAILED: 2000 MB did not run under $LIMIT" >&2; exit 1; }
  set +e
  systemd-run --user --scope --quiet -p MemoryMax="$LIMIT" -p MemorySwapMax=0 bash -c "$inner" memcap python3 -I -c "$alloc" 3500
  RC=$?; set -e
  [ $RC -ne 0 ] && { echo "[memcap] check PASS: 2000 MB ran, 3500 MB was stopped (exit $RC): the $LIMIT cap is enforced"; exit 0; }
  echo "[memcap] check FAILED: 3500 MB ran under $LIMIT" >&2; exit 1
fi
[ $# -ge 1 ] || { echo "usage: $0 [--check] 3G <command...>" >&2; exit 2; }
evict
exec systemd-run --user --scope --quiet -p MemoryMax="$LIMIT" -p MemorySwapMax=0 bash -c "$inner" memcap "$@"
