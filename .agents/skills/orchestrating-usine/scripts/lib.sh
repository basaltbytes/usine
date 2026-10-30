#!/usr/bin/env bash
# Sourced by every script here. Loads env.sh from the repository's .scratchpad.
set -euo pipefail

usine_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

USINE_STATE="${USINE_STATE:-$(usine_root)/.scratchpad/orchestrating-usine}"
ENV_FILE="$USINE_STATE/env.sh"

# env.sh is sourced only when it is the current user's own untracked file with no group or world access.
if [ -f "$ENV_FILE" ]; then
  if [ ! -O "$ENV_FILE" ]; then
    echo "refusing $ENV_FILE: not owned by $(id -un)" >&2; exit 1
  fi
  if [ -n "$(find "$ENV_FILE" -perm +077 2>/dev/null || find "$ENV_FILE" -perm /077 2>/dev/null)" ]; then
    echo "refusing $ENV_FILE: mode must be 0600" >&2; exit 1
  fi
  if git -C "$(dirname "$ENV_FILE")" ls-files --error-unmatch "$ENV_FILE" >/dev/null 2>&1; then
    echo "refusing $ENV_FILE: tracked by git" >&2; exit 1
  fi
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

: "${USINE_URL:=http://127.0.0.1:7331}"
: "${USINE_TOKEN:=}"
: "${USINE_SSH:=}"
: "${USINE_DIR:=}"
: "${USINE_BIN:=usine}"
: "${USINE_REPOS:=}"
: "${USINE_APP:=}"

# usine_token prints the bearer token: USINE_TOKEN, or the instance's admin token read over SSH
# (`.usine/admin-token`, rotated on every server start) and cached in a 0600 file.
usine_token() {
  if [ -n "$USINE_TOKEN" ]; then printf '%s' "$USINE_TOKEN"; return 0; fi
  [ -n "$USINE_SSH" ] && [ -n "$USINE_DIR" ] || return 0
  local cache="$USINE_STATE/admin-token"
  if [ ! -s "$cache" ] || [ "${USINE_TOKEN_REFRESH:-0}" = 1 ]; then
    if (umask 077; ssh -o ConnectTimeout=10 "$USINE_SSH" "cat $USINE_DIR/.usine/admin-token" > "$cache.tmp" 2>/dev/null) && [ -s "$cache.tmp" ]; then
      mv "$cache.tmp" "$cache"
    else
      rm -f "$cache.tmp"; return 0
    fi
  fi
  cat "$cache"
}

# usine_api METHOD PATH [BODY]. The token travels in a 0600 header file, never on the command line.
# A 401 with the admin-token fallback refreshes the token once and retries.
usine_api() {
  local method="$1" path="$2" body="${3:-}" attempt token out status
  for attempt in 1 2; do
    token="$(usine_token)"
    local args=(-sS --max-time 30 -X "$method" -H 'content-type: application/json' -H 'accept: application/json' -w '\n%{http_code}')
    if [ -n "$token" ]; then
      local header="$USINE_STATE/.auth-header"
      (umask 077; printf 'authorization: Bearer %s\n' "$token" > "$header")
      args+=(-H "@$header")
    fi
    if [ -n "$body" ]; then
      args+=(--data "$body")
    fi
    out="$(curl "${args[@]}" "$USINE_URL$path")" || return $?
    status="${out##*$'\n'}"
    out="${out%$'\n'*}"
    if [ "$status" = 401 ] && [ -z "$USINE_TOKEN" ] && [ "$attempt" = 1 ]; then
      USINE_TOKEN_REFRESH=1; continue
    fi
    printf '%s' "$out"
    return 0
  done
}

# usine_host CMD... runs on the orchestrator host, locally when USINE_SSH is empty.
usine_host() {
  if [ -n "$USINE_SSH" ]; then
    ssh -o ConnectTimeout=10 "$USINE_SSH" "$@"
  else
    bash -c "$*"
  fi
}

py() { python3 -I "$@"; }
