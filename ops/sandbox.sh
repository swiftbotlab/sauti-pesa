#!/bin/bash
# Run a command for this project inside a bubblewrap ALLOWLIST sandbox.
#
#   ops/sandbox.sh offline <cmd...>   network OFF: own empty network namespace. All AI and all signing run here.
#   ops/sandbox.sh devnet  <cmd...>   network OFF from the internet, but a private loopback inside the sandbox, so a
#                                      local test chain (anvil) and the broadcaster can talk to each other
#   ops/sandbox.sh online  node bin/netsync.mjs ...   host network, for the public TESTNET broadcaster only
#   ops/sandbox.sh setup   <cmd...>   host network, only `npm ci` (install scripts forced off) and `curl`
#
# The project directory is mounted READ-ONLY in every mode. Each mode gets write access only to what it needs:
#   offline  private/ queue/ tmp/ home/
#   devnet   queue/devnet/ home/                     private/ and tmp/ are masked (empty)
#   online   queue/<network>/ home/                  private/ and tmp/ are masked (empty)
#   setup    node_modules/ models/ home/             private/, queue/ and tmp/ are masked (empty)
# (with SAUTI_DATA=tmp/<name>, a test run, the same layout lives under tmp/<name>/ instead.)
# So code inside a sandbox can never change files that run on the host (bin/, ops/, scripts/, src/, ui/, .git).
#
# Also inside: /usr and /etc read-only, an empty /tmp, /run, /home and /var (tmpfs), a cleared environment
# (--clearenv, rebuilt from a short allowlist below) and HOME = the project's own home/ directory.
# Not visible: the rest of the real home directory, other projects, /var, the D-Bus and resolver sockets.
#
# online and setup share the host network namespace (this script does not set up a user-mode network stack),
# which also means services on the host's 127.0.0.1 are reachable from them. That is why they never run
# third-party package code: setup only runs npm (lifecycle scripts off) and curl, online only runs our
# bin/netsync.mjs (plus ethers for decoding), whose RPC client talks https to allow-listed testnet endpoints only.
#
# devnet and online runs take an exclusive lock on the network's queue directory (flock), so a broadcast started
# from the CLI and one started from the UI never overlap.
set -euo pipefail
PROD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
. "$PROD/ops/lib.sh"
load_local_env "$PROD" # optional machine-local settings, e.g. SAUTI_ANVIL=/path/to/anvil
MODE="${1:-}"; shift || true
[ $# -ge 1 ] || { echo "usage: $0 offline|devnet|online|setup <cmd...>" >&2; exit 2; }
case "$MODE" in offline|devnet|online|setup) ;; *) echo "mode must be offline|devnet|online|setup" >&2; exit 2 ;; esac

die () { echo "sandbox: $*" >&2; exit 2; }

# Test runs keep their wallet and outbox under tmp/<name> (SAUTI_DATA). Accept only that shape.
DATA="$PROD"
if [ -n "${SAUTI_DATA:-}" ]; then
  rel="${SAUTI_DATA#"$PROD"/}"
  [[ "$rel" =~ ^tmp(/[A-Za-z0-9_-][A-Za-z0-9._-]*){1,4}$ ]] && [[ "$rel" != *..* ]] || die "SAUTI_DATA must be tmp/<name>"
  DATA="$PROD/$rel"
fi

# A directory we bind read-write must be a real directory at exactly this path: no symlink anywhere on the way
# (a sandbox that can write queue/ must not be able to turn queue/sepolia into a link to some other directory).
rwdir () {
  local d="$1"
  [ "$(realpath -m "$d")" = "$d" ] || die "$d is or goes through a symlink; refusing"
  mkdir -p "$d"
  [ "$(realpath -e "$d")" = "$d" ] && [ -d "$d" ] || die "$d resolves elsewhere; refusing"
  RWS+=("$d")
}
# Hide a directory behind an empty, read-only tmpfs (the directory is created first: a fresh clone has none of them).
mask () {
  [ "$(realpath -m "$1")" = "$1" ] || die "$1 is or goes through a symlink; refusing"
  mkdir -p "$1"; MASKS+=("$1")
}
MASKS=(); RWS=()

ARGS=(--unshare-user-try --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
      --new-session --die-with-parent --clearenv --cap-drop ALL
      --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/sbin /sbin
      --ro-bind /etc /etc
      --dev /dev --proc /proc --tmpfs /tmp --tmpfs /run --tmpfs /home --tmpfs /var
      --ro-bind "$PROD" "$PROD")
TMPDIR_IN=/tmp
LOCKDIR=""

case "$MODE" in
  offline)
    # a test run (SAUTI_DATA) never sees the real wallet or outbox
    if [ "$DATA" != "$PROD" ]; then mask "$PROD/private"; mask "$PROD/queue"; fi
    rwdir "$PROD/tmp"; rwdir "$PROD/home"; rwdir "$DATA/private"; rwdir "$DATA/queue"
    chmod 700 "$DATA/private"
    TMPDIR_IN="$PROD/tmp"
    ARGS+=(--unshare-net)
    ;;
  devnet|online)
    if [ "$MODE" = devnet ]; then
      NET=devnet
      # Foundry's anvil (official release binary), read-only, for the local chain
      ANVIL="${SAUTI_ANVIL:-$(command -v anvil || true)}"
      [ -n "$ANVIL" ] && [ -x "$ANVIL" ] || die "devnet needs Foundry's anvil: install it (https://getfoundry.sh) or set SAUTI_ANVIL=/path/to/anvil"
    else
      [ "$1" = node ] && [ "${2:-}" = bin/netsync.mjs -o "${2:-}" = ops/sandbox_probe.mjs ] || die "online mode only runs: node bin/netsync.mjs ... (or the probe)"
      NET=sepolia
      for ((i = 1; i <= $#; i++)); do [ "${!i}" = --network ] && { j=$((i + 1)); NET="${!j:-}"; }; done
      [ "$NET" = devnet ] && die "use ops/devnet.sh for the local devnet"
      [[ "$NET" =~ ^[a-z0-9-]{1,20}$ ]] || die "bad --network"
    fi
    # only the outbox of this one network is writable
    mask "$PROD/private"; mask "$PROD/tmp"; mask "$PROD/queue"
    mkdir -p "$PROD/queue" "$DATA/queue"
    rwdir "$DATA/queue/$NET"
    rwdir "$PROD/home"
    LOCKDIR="$DATA/queue/$NET"
    if [ "$MODE" = devnet ]; then
      ARGS+=(--unshare-net --ro-bind "$(readlink -f "$ANVIL")" /opt/foundry/anvil)
    else
      STUB=/run/systemd/resolve/stub-resolv.conf
      [ -f "$STUB" ] && ARGS+=(--ro-bind "$STUB" "$STUB")
    fi
    ;;
  setup)
    case "$(basename "$1")" in
      npm|curl|sha256sum|ls|du|true) ;;
      *) die "setup mode only runs npm/curl/sha256sum (refusing $1)" ;;
    esac
    if [ "$(basename "$1")" = npm ]; then
      case "${2:-}" in ci|ls|view|audit|query) ;; *) die "npm ${2:-} not allowed in setup mode" ;; esac
    fi
    mask "$PROD/private"; mask "$PROD/tmp"; mask "$PROD/queue"
    rwdir "$PROD/node_modules"; rwdir "$PROD/models"; rwdir "$PROD/home"
    STUB=/run/systemd/resolve/stub-resolv.conf
    [ -f "$STUB" ] && ARGS+=(--ro-bind "$STUB" "$STUB")
    ARGS+=(--setenv npm_config_ignore_scripts true --setenv npm_config_audit false
           --setenv npm_config_fund false --setenv npm_config_update_notifier false
           --setenv npm_config_cache "$PROD/home/.npm")
    ;;
esac

# Order matters: empty tmpfs masks, the mount points for writable directories inside them, the masks made
# read-only, and only then the writable binds (a later read-only remount would also cover mounts below it).
for m in "${MASKS[@]}"; do ARGS+=(--tmpfs "$m"); done
for d in "${RWS[@]}"; do for m in "${MASKS[@]}"; do [[ "$d" == "$m"/* ]] && ARGS+=(--dir "$d"); done; done
for m in "${MASKS[@]}"; do ARGS+=(--remount-ro "$m"); done
for d in "${RWS[@]}"; do ARGS+=(--bind "$d" "$d"); done
ARGS+=(--chdir "$PROD"
       --setenv HOME "$PROD/home" --setenv TMPDIR "$TMPDIR_IN" --setenv PATH /usr/bin:/bin
       --setenv LANG C.UTF-8 --setenv NODE_ENV production
       --setenv SAUTI_SANDBOX "$MODE")
[ -n "$LOCKDIR" ] && ARGS+=(--setenv SAUTI_QUEUE_LOCKED 1)
# pass through only our own tuning variables (SAUTI_*, ASR_*, LLM_*) with plain values; never the UI token
while IFS='=' read -r k v; do
  [[ "$k" =~ ^(SAUTI_|ASR_|LLM_)[A-Z0-9_]+$ ]] && [[ "$k" != SAUTI_SANDBOX && "$k" != SAUTI_UI_TOKEN && "$k" != SAUTI_QUEUE_LOCKED ]] \
    && [[ "$v" =~ ^[A-Za-z0-9._:/,-]{0,200}$ ]] && ARGS+=(--setenv "$k" "$v")
done < <(env)

if [ -n "$LOCKDIR" ]; then
  # Lock the queue DIRECTORY itself (checked above: a real directory, no symlink), so there is no lock file a
  # sandbox could swap for a link. The open descriptor is inherited by bwrap, so the lock lasts for the whole run.
  WAIT="${SAUTI_LOCK_WAIT:-120}"; [[ "$WAIT" =~ ^[0-9]{1,4}$ ]] || die "SAUTI_LOCK_WAIT must be seconds"
  exec 9<"$LOCKDIR"
  flock -w "$WAIT" 9 || die "another sync/broadcast for $NET is still running (lock on queue/$NET)"
fi
exec /usr/bin/bwrap "${ARGS[@]}" "$@"
