#!/bin/bash
# Download models that QVAC publishes ONLY in its own peer-to-peer model registry (today: the OCR weights,
# registry source "s3", no Hugging Face origin), once, then verify size + sha256 like scripts/fetch_models.sh.
#   scripts/fetch_registry_model.sh OCR_LATIN OCR_CRAFT        (scripts/fetch_models.sh calls this for them)
#   scripts/fetch_registry_model.sh --probe PORT               isolation check: host vs fence, PORT = a local service
#
# This is the only place where package code (QVAC's @qvac/registry-client, pinned in package-lock.json) runs
# with a network. It is fenced in two layers:
#   1. pasta (package "passt") gives it its OWN network namespace with internet access only: host loopback is not
#      forwarded (-T none -U none, --no-map-gw), and routes inside refuse 10/8, 172.16/12, 192.168/16, 100.64/10,
#      169.254/16 and the namespace's own subnet and gateway, so it cannot reach services on this machine or the
#      local network (some hypervisors forward the gateway address back to the host's loopback). DNS goes through
#      pasta to the host's resolver.
#   2. bubblewrap: the project read-only, only a fresh staging directory under tmp/ writable, private/ queue/
#      tmp/ home/ and the real home masked, cleared environment, no capabilities (so it cannot change those routes).
# The downloaded file is checked on the HOST (size + sha256 from models.json, which must equal the SDK's own
# registry constant; registry_fetch.cjs compares them before downloading) and only then moved into models/.
set -euo pipefail
PROD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$PROD"
[ $# -ge 1 ] || { echo "usage: $0 OCR_LATIN [OCR_CRAFT ...] | --probe PORT" >&2; exit 2; }
command -v pasta >/dev/null || { echo "needs pasta (Debian/Ubuntu: sudo apt install passt) to fence the registry download" >&2; exit 2; }
DNS_HOST=$(awk '/^nameserver[[:space:]]/{print $2; exit}' /etc/resolv.conf)
[[ "$DNS_HOST" =~ ^[0-9.]{7,15}$ ]] || { echo "no IPv4 nameserver in /etc/resolv.conf" >&2; exit 2; }
DNS_FWD=198.51.100.53   # TEST-NET-2 address inside the namespace; pasta forwards DNS sent to it
RESOLV_TARGET=/etc/resolv.conf
[ -L /etc/resolv.conf ] && RESOLV_TARGET="$(readlink -f /etc/resolv.conf)"
mkdir -p models tmp

# fenced STAGE CMD... : run CMD in the project, network fenced as described above, only STAGE writable
fenced () {
  local stage="$1"; shift
  printf 'nameserver %s\n' "$DNS_FWD" > "$stage/resolv.conf"
  timeout 900 pasta -q -4 --config-net --no-map-gw -t none -u none -T none -U none \
      --dns-forward "$DNS_FWD" --dns-host "$DNS_HOST" -- \
    /usr/bin/bash -c '
      set -e
      STAGE="$1"; RESOLV="$2"; PROD="$3"; shift 3
      for n in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4; do
        ip route add prohibit "$n" metric 0
      done
      # the namespace copies the host subnet and gateway routes: refuse those destinations too
      for n in $(ip -4 route show | awk "\$2==\"dev\" && \$1 ~ /^[0-9.]+(\\/[0-9]+)?\$/ {print \$1}" | sort -u); do
        ip route add prohibit "$n" metric 0 2>/dev/null || true
      done
      GW=$(ip -4 route show default | awk "{print \$3; exit}")
      [ -n "$GW" ] && { ip route add prohibit "$GW/32" metric 0 2>/dev/null || true; }
      if ip route get "${GW:-192.168.0.1}" >/dev/null 2>&1; then echo "fence: gateway still routable" >&2; exit 3; fi
      exec /usr/bin/bwrap --unshare-user-try --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try \
        --new-session --die-with-parent --clearenv --cap-drop ALL \
        --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/sbin /sbin \
        --ro-bind /etc /etc --dev /dev --proc /proc --tmpfs /tmp --tmpfs /run --tmpfs /home --tmpfs /var \
        --ro-bind "$STAGE/resolv.conf" "$RESOLV" \
        --ro-bind "$PROD" "$PROD" \
        --tmpfs "$PROD/private" --tmpfs "$PROD/queue" --tmpfs "$PROD/tmp" --tmpfs "$PROD/home" \
        --remount-ro "$PROD/private" --remount-ro "$PROD/queue" --remount-ro "$PROD/home" \
        --bind "$STAGE" "$STAGE" \
        --chdir "$PROD" --setenv HOME "$STAGE" --setenv TMPDIR "$STAGE" --setenv PATH /usr/bin:/bin \
        --setenv LANG C.UTF-8 --setenv NODE_ENV production --setenv SAUTI_FETCH_STAGE "$STAGE" \
        --setenv SAUTI_FETCH_GW "${GW:-}" \
        "$@"
    ' fence "$stage" "$RESOLV_TARGET" "$PROD" "$@"
}

if [ "$1" = --probe ]; then
  PORT="${2:-}"; [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || { echo "usage: $0 --probe PORT" >&2; exit 2; }
  GW_HOST=$(ip -4 route show default | awk '{print $3; exit}')
  tcp () { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null && echo true || echo false; }
  echo "host:  127.0.0.1:$PORT=$(tcp 127.0.0.1 "$PORT")  gateway ${GW_HOST:-none}:$PORT=$( [ -n "$GW_HOST" ] && tcp "$GW_HOST" "$PORT" || echo n/a)"
  STAGE=$(mktemp -d "$PROD/tmp/registry-fetch.XXXXXX"); chmod 700 "$STAGE"
  set +e
  fenced "$STAGE" /usr/bin/bash -c '
    tcp () { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null && echo true || echo false; }
    echo "fence: 127.0.0.1:$1=$(tcp 127.0.0.1 "$1")  gateway ${SAUTI_FETCH_GW:-none}:$1=$( [ -n "$SAUTI_FETCH_GW" ] && tcp "$SAUTI_FETCH_GW" "$1" || echo n/a)  10.0.0.1:443=$(tcp 10.0.0.1 443)"
    echo "fence: dns=$(getent hosts registry.npmjs.org >/dev/null && echo true || echo false)  https=$(curl -sS -m 8 -o /dev/null -w %{http_code} https://registry.npmjs.org/-/ping 2>/dev/null)"
    echo "fence: route change allowed=$(ip route add 1.2.3.4/32 dev eth0 2>/dev/null && echo true || echo false)  writable project=$(touch bin/.probe 2>/dev/null && echo true || echo false)  private entries=$(ls -A private | wc -l)"
  ' probe "$PORT"
  RC=$?; set -e
  rm -rf -- "$STAGE"; exit $RC
fi

for KEY in "$@"; do
  [[ "$KEY" =~ ^[A-Z0-9_]{2,60}$ ]] || { echo "bad key $KEY" >&2; exit 2; }
  read -r FILE SHA BYTES < <(python3 -I -c '
import json,sys
m=json.load(open("models.json"))[sys.argv[1]]
r=m["registry"]
assert r["registrySource"]=="s3" and m["qvac_constant"]==sys.argv[1], "not a QVAC registry entry"
assert "/" not in m["file"] and not m["file"].startswith(".")
print(m["file"], m["sha256"], m["bytes"])' "$KEY")
  ENTRY=$(python3 -I -c 'import json,sys; print(json.dumps(json.load(open("models.json"))[sys.argv[1]], separators=(",",":")))' "$KEY")
  OUT="models/$FILE"
  if [ -f "$OUT" ] && [ "$(stat -c %s "$OUT")" = "$BYTES" ] && echo "$SHA  $OUT" | sha256sum -c --status; then
    echo "$KEY: already present and verified"; continue
  fi
  STAGE=$(mktemp -d "$PROD/tmp/registry-fetch.XXXXXX"); chmod 700 "$STAGE"
  echo "$KEY: downloading $BYTES bytes from the QVAC registry (fenced)"
  set +e
  fenced "$STAGE" node scripts/registry_fetch.cjs "$KEY" "$ENTRY" "$STAGE/$FILE"
  RC=$?; set -e
  if [ $RC -ne 0 ]; then echo "$KEY: download failed (exit $RC)" >&2; rm -rf -- "$STAGE"; exit 1; fi
  PART="$STAGE/$FILE"
  [ -f "$PART" ] && [ ! -L "$PART" ] || { echo "$KEY: no regular file was written" >&2; rm -rf -- "$STAGE"; exit 1; }
  SIZE=$(stat -c %s "$PART")
  [ "$SIZE" = "$BYTES" ] || { echo "$KEY: size $SIZE != $BYTES" >&2; rm -rf -- "$STAGE"; exit 1; }
  echo "$SHA  $PART" | sha256sum -c --status || { echo "$KEY: sha256 mismatch" >&2; rm -rf -- "$STAGE"; exit 1; }
  mv "$PART" "$OUT"; chmod 444 "$OUT"
  rm -rf -- "$STAGE"
  echo "$KEY: ok sha256=$SHA"
done
