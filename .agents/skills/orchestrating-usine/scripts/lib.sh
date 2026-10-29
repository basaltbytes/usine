#!/usr/bin/env bash
# Sourced by every script here. Loads env.sh from the repository's .scratchpad.
set -euo pipefail

usine_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

USINE_STATE="${USINE_STATE:-$(usine_root)/.scratchpad/orchestrating-usine}"
ENV_FILE="$USINE_STATE/env.sh"

if [ -f "$ENV_FILE" ]; then
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

# usine_api METHOD PATH [BODY]
usine_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS --max-time 30 -X "$method" -H 'content-type: application/json' -H 'accept: application/json')
  if [ -n "$USINE_TOKEN" ]; then
    args+=(-H "authorization: Bearer $USINE_TOKEN")
  fi
  if [ -n "$body" ]; then
    args+=(--data "$body")
  fi
  curl "${args[@]}" "$USINE_URL$path"
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
