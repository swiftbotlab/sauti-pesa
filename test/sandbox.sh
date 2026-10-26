#!/bin/bash
# Sandbox tests, each with a positive control (the attack works without the guard, then the guard stops it).
# No models, no internet needed (the online-mode probe just reports what it can reach).
#   test/sandbox.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROD="$(pwd -P)"
T=tmp/sandbox-test
rm -rf "$T" && mkdir -p "$T"
pass=0; fail () { echo "  FAIL $*"; exit 1; }; ok () { pass=$((pass + 1)); echo "  ok   $*"; }
field () { python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read().strip().splitlines()[-1])[sys.argv[1]])' "$1"; }
sum () { sha256sum bin/bridge.mjs | cut -c1-64; }
BEFORE=$(sum)

# 1. Host-run code is read-only in every mode. Positive control: the OLD binding (whole project read-write)
#    lets the sandbox open bin/bridge.mjs for writing (append mode, nothing is written).
bwrap --unshare-net --die-with-parent --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib \
  --ro-bind /etc /etc --dev /dev --proc /proc --bind "$PROD" "$PROD" --chdir "$PROD" \
  /bin/bash -c ': >> bin/bridge.mjs' && ok "control: old read-write binding can open bin/bridge.mjs for writing" \
  || fail "control: old binding could not write (test is broken)"
if ops/sandbox.sh offline /bin/bash -c ': >> bin/bridge.mjs' 2>/dev/null; then fail "offline mode can write bin/bridge.mjs"; fi
ok "offline mode cannot write bin/bridge.mjs"
if ops/sandbox.sh offline /bin/bash -c ': > ops/new_file.sh' 2>/dev/null; then rm -f ops/new_file.sh; fail "offline mode can create files in ops/"; fi
ok "offline mode cannot create files in ops/"
[ "$(sum)" = "$BEFORE" ] || fail "bin/bridge.mjs changed"
[ "$(node ops/sandbox_probe.mjs | field host_code_writable)" = True ] || fail "probe control: host should see host code as writable"
ok "probe control: host_code_writable is true on the host"
for m in offline devnet online; do
  [ "$(ops/sandbox.sh $m node ops/sandbox_probe.mjs 2>/dev/null | field host_code_writable)" = False ] || fail "$m: host code writable"
  ok "$m: host_code_writable false"
done
[ "$(ops/sandbox.sh offline node ops/sandbox_probe.mjs | field tmp_writable)" = True ] || fail "offline: tmp/ should be writable"
ok "offline: tmp/ writable (positive control for the probe's write test)"

# 2. Throwaway test seeds under tmp/*/private are invisible to devnet, online and setup.
mkdir -p "$T/data/private" && echo '{"test":"placeholder, not a seed"}' > "$T/data/private/wallet.json" && chmod 600 "$T/data/private/wallet.json"
export SAUTI_DATA="$T/data"
ops/sandbox.sh offline /bin/bash -c "test -f $T/data/private/wallet.json" && ok "control: offline (the signer) sees the test wallet" || fail "control: offline cannot see the test wallet"
if ops/sandbox.sh devnet /bin/bash -c "test -e $T/data/private/wallet.json || test -e private/wallet.json" 2>/dev/null; then fail "devnet sees a wallet"; fi
ok "devnet: no wallet visible (tmp/ and private/ masked)"
for m in online setup; do
  if [ $m = online ]; then out=$(ops/sandbox.sh online node ops/sandbox_probe.mjs 2>/dev/null); else out=$(ops/sandbox.sh setup ls -A tmp private 2>/dev/null | tr -d '\n'); fi
  if [ $m = online ]; then [ "$(echo "$out" | field wallet_files_in_tmp)" = 0 ] && [ "$(echo "$out" | field private_entries)" = 0 ] || fail "online sees a wallet in tmp/ or private/"
  else [ "$out" = "private:tmp:" ] || fail "setup sees tmp/ or private/: $out"; fi
  ok "$m: no wallet in tmp/, private/ empty"
done
[ "$(ops/sandbox.sh offline node ops/sandbox_probe.mjs | field wallet_files_in_tmp)" -ge 1 ] && ok "control: the probe finds the test wallet from offline mode" || fail "probe control"
[ "$(env -u SAUTI_DATA ops/sandbox.sh online node ops/sandbox_probe.mjs | field tmp_entries)" = 0 ] && ok "online (real data): tmp/ is empty" || fail "online sees tmp/"
ops/sandbox.sh devnet /bin/bash -c "touch $T/data/queue/devnet/.w && rm $T/data/queue/devnet/.w" && ok "devnet: its own outbox (queue/devnet) is writable" || fail "devnet outbox not writable"
if ops/sandbox.sh devnet /bin/bash -c "touch $T/data/x" 2>/dev/null; then fail "devnet can write the masked tmp/"; fi
ok "devnet: masks are read-only"

# 3. A writable directory turned into a symlink is refused (no bind of some other directory).
mkdir -p "$T/elsewhere" "$T/link/queue"
ln -s "$PROD/$T/elsewhere" "$T/link/queue/devnet"
if SAUTI_DATA="$T/link" ops/sandbox.sh devnet /bin/true 2>"$T/link.err"; then fail "symlinked outbox was accepted"; fi
grep -q symlink "$T/link.err" && ok "symlinked queue/devnet refused" || fail "unexpected error: $(cat "$T/link.err")"

# 4. One netsync run per network at a time (CLI vs UI): the queue directory is locked.
mkdir -p "$T/data/queue/sepolia"
SAUTI_LOCK_WAIT=0 ops/sandbox.sh online node bin/netsync.mjs status --network sepolia >/dev/null && ok "control: status runs when nobody holds the lock" || fail "status failed without a lock holder"
flock "$T/data/queue/sepolia" sleep 4 &
HOLD=$!; sleep 0.5
if SAUTI_LOCK_WAIT=1 ops/sandbox.sh online node bin/netsync.mjs status --network sepolia >/dev/null 2>"$T/lock.err"; then fail "second run did not wait for the lock"; fi
grep -q 'still running' "$T/lock.err" && ok "a second run is refused while the first holds the lock" || fail "unexpected: $(cat "$T/lock.err")"
wait $HOLD
if SAUTI_SANDBOX=online SAUTI_QUEUE_LOCKED= node bin/netsync.mjs status --network sepolia >/dev/null 2>&1; then fail "netsync ran outside the wrapper"; fi
ok "netsync refuses to run without the sandbox + lock"
unset SAUTI_DATA

# 5. ops/local.env is parsed, never executed.
mkdir -p "$T/fake/ops"
printf '%s\n' '# comment' 'SAUTI_GOOD=/opt/x' "SAUTI_BAD=\$(touch $PROD/$T/pwned)" "touch $PROD/$T/pwned2" 'SAUTI_SANDBOX=online' > "$T/fake/ops/local.env"
chmod 600 "$T/fake/ops/local.env"
r=$(bash -c '. ops/lib.sh; load_local_env "$1" 2>/dev/null; echo "${SAUTI_GOOD:-}|${SAUTI_BAD:-}|${SAUTI_SANDBOX:-}"' _ "$PROD/$T/fake")
[ "$r" = "/opt/x||" ] && [ ! -e "$T/pwned" ] && [ ! -e "$T/pwned2" ] && ok "local.env: plain values read, code ignored" || fail "local.env parse gave '$r'"
chmod 666 "$T/fake/ops/local.env"
r=$(bash -c '. ops/lib.sh; load_local_env "$1" 2>/dev/null; echo "${SAUTI_GOOD:-}"' _ "$PROD/$T/fake")
[ -z "$r" ] && ok "local.env: a group/world-writable file is ignored" || fail "writable local.env was used"

[ "$(sum)" = "$BEFORE" ] || fail "bin/bridge.mjs changed"
rm -rf "$T"
echo "SANDBOX PASS ($pass checks)"
