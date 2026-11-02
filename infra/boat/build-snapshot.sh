#!/bin/sh
# Builds a credential-free Boat snapshot with Tailscale.
set -eu
[ "$#" -eq 2 ] || { echo "Usage: $0 <snapshot-name> <ssh-identity-file>" >&2; exit 2; }
: "${BOAT_API_KEY:?Set BOAT_API_KEY to your Boat API key}"
name=$1
identity=$2
printf '%s\n' "$name" | LC_ALL=C grep -Eq '^[a-z0-9][a-z0-9-]{0,62}$' || { echo 'Invalid snapshot name' >&2; exit 2; }
case "$name" in latest|tree|pull|rm|save|current|self|new) echo 'Reserved snapshot name' >&2; exit 2;; esac
[ -f "$identity" ] && [ -f "$identity.pub" ] || { echo 'The SSH identity and its .pub file must exist' >&2; exit 2; }
work=$(mktemp -d)
source_sandbox=
verification_sandbox=
api() {
  method=$1
  path=$2
  shift 2
  printf 'header = %s\n' "$(printf 'Authorization: Bearer %s' "$BOAT_API_KEY" | jq -Rs .)" |
    curl --silent --show-error --fail-with-body --max-time 60 --config - \
      -X "$method" -H 'Content-Type: application/json' "https://boat.dev/api/v1$path" "$@"
}
cleanup() {
  for cleanup_sandbox in "$verification_sandbox" "$source_sandbox"; do
    if [ -n "$cleanup_sandbox" ]; then
      api DELETE "/sandboxes/$cleanup_sandbox" -H "X-Ascii-Confirm-Delete: $cleanup_sandbox" >/dev/null ||
        echo "Could not delete sandbox $cleanup_sandbox; delete it in Boat." >&2
    fi
  done
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
remote() {
  ssh -i "$identity" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    -o StrictHostKeyChecking=yes -o HostKeyAlias=usine-boat-snapshot \
    -o "UserKnownHostsFile=$work/known_hosts" "$user@$host" "$@"
}
connect_sandbox() {
  sandbox=$1
  tries=0
  while :; do
    api GET "/sandboxes/$sandbox" > "$work/sandbox.json"
    state=$(jq -er '.sandbox.state' "$work/sandbox.json")
    case "$state" in
      ready|idle|running) break;;
      error|cancelled|archiving|archived) echo "Sandbox ended in $state" >&2; exit 1;;
    esac
    tries=$((tries + 1))
    [ "$tries" -lt 100 ] || { echo 'Sandbox readiness timed out' >&2; exit 1; }
    sleep 3
  done
  api POST "/sandboxes/$sandbox/sshkey" --data "$(jq -nc --arg key "$(cat "$identity.pub")" '{key:$key}')" > "$work/ssh.json"
  host_key=$(jq -er '.hostKey' "$work/ssh.json")
  printf 'usine-boat-snapshot %s\n' "$host_key" > "$work/known_hosts"
  user=$(jq -r '.sshUser // "user"' "$work/ssh.json")
  endpoint=$(jq -r '.sshEndpoint // empty' "$work/ssh.json")
  if [ -n "$endpoint" ]; then
    host=${endpoint%:*}
    port=${endpoint##*:}
  else
    host=$(jq -er '.machineIp' "$work/ssh.json")
    port=22
  fi
  tries=0
  until remote true 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || { echo 'SSH readiness timed out' >&2; exit 1; }
    sleep 3
  done
}
if command -v uuidgen >/dev/null 2>&1; then
  key=$(uuidgen)
else
  key=$(cat /proc/sys/kernel/random/uuid)
fi
api POST /sandboxes -H "Idempotency-Key: $key" --data \
  "$(jq -nc --arg name "usine-snapshot-$name" '{name:$name,noEnv:true,snapshots:true,monitoring:false,ttlSeconds:3600}')" > "$work/created.json"
source_sandbox=$(jq -er '.sandbox.id' "$work/created.json")
echo "Preparing source sandbox $source_sandbox" >&2
connect_sandbox "$source_sandbox"
remote 'sh -ec '\''
  curl -fsSL https://tailscale.com/install.sh -o /tmp/usine-install-tailscale.sh
  sudo sh /tmp/usine-install-tailscale.sh
  rm /tmp/usine-install-tailscale.sh
  sudo systemctl enable --now tailscaled
  test -c /dev/net/tun
  sudo systemctl stop tailscaled
  sudo rm -f /var/lib/tailscale/tailscaled.state
  sync
'\'''
echo "Saving snapshot $name; this can take several minutes" >&2
api POST /saved-snapshots --data "$(jq -nc --arg sandboxId "$source_sandbox" --arg name "$name" '{sandboxId:$sandboxId,name:$name}')" > "$work/saved.json"
tries=0
while :; do
  api GET "/saved-snapshots/$name" > "$work/snapshot.json"
  state=$(jq -er '.snapshot.status' "$work/snapshot.json")
  case "$state" in
    ready) break;;
    failed) echo "Saving snapshot $name failed" >&2; exit 1;;
    saving) ;;
    *) echo "Unknown snapshot state: $state" >&2; exit 1;;
  esac
  tries=$((tries + 1))
  [ "$tries" -lt 180 ] || { echo 'Snapshot save timed out; check its status in Boat' >&2; exit 1; }
  sleep 5
done
echo "Verifying snapshot $name on a fresh sandbox" >&2
api POST /sandboxes -H "Idempotency-Key: $key-verify" --data \
  "$(jq -nc --arg name "usine-verify-$name" --arg from "$name" '{name:$name,from:$from,noEnv:true,snapshots:false,monitoring:false,ttlSeconds:900}')" > "$work/verification.json"
verification_sandbox=$(jq -er '.sandbox.id' "$work/verification.json")
connect_sandbox "$verification_sandbox"
if ! remote 'tailscale version' >/dev/null; then
  echo "Snapshot $name verification failed: cannot run Tailscale on sandbox $verification_sandbox." >&2
  exit 1
fi
echo "Snapshot $name is verified and ready"
