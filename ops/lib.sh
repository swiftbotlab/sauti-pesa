# Shared helpers for the scripts in ops/, scripts/ and test/ (sourced, never run on their own).
#
# load_local_env: machine-local settings (optional file ops/local.env, not in git).
# The file is PARSED, never executed: only lines of the form SAUTI_NAME=plain-value are read, and a variable
# that is already set in the environment wins. The file must be a regular file owned by you and not writable
# by group or others (the sandboxes cannot write to ops/ at all; this is a second check).
#   . ops/lib.sh; load_local_env "$PROD"
load_local_env () {
  local f="$1/ops/local.env" line k v
  [ -e "$f" ] || [ -L "$f" ] || return 0
  if [ -L "$f" ] || [ ! -f "$f" ]; then echo "ops/local.env must be a regular file (not a symlink); ignoring it" >&2; return 0; fi
  if [ "$(stat -c %u "$f")" != "$(id -u)" ] || [ $(( 0$(stat -c %a "$f") & 022 )) -ne 0 ]; then
    echo "ops/local.env must be owned by you and not group/world-writable (chmod 600); ignoring it" >&2; return 0
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    if [[ "$line" =~ ^(SAUTI_[A-Z0-9_]{1,40})=([A-Za-z0-9._/:,+@-]{0,300})$ ]]; then
      k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
      [ "$k" = SAUTI_SANDBOX ] || [ "$k" = SAUTI_UI_TOKEN ] && continue
      [ -n "${!k+x}" ] || printf -v "$k" '%s' "$v"
    else
      echo "ops/local.env: ignoring a line that is not SAUTI_NAME=plain-value" >&2
    fi
  done < "$f"
}

# A fresh random key for the local UI (URL-safe, 43 characters). ops/ui.sh puts it in the URL fragment; the page
# sends it back in a header and the bridge refuses API calls without it.
new_ui_token () { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
valid_ui_token () { [[ "${1:-}" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; }
