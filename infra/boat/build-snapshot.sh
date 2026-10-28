#!/bin/sh
# Builds a credential-free Boat snapshot with Tailscale and a retained attempt image.
set -eu
[ "$#" -eq 3 ] || { echo "Usage: $0 <snapshot-name> <attempt-image> <ssh-identity-file>" >&2; exit 2; }
: "${BOAT_API_KEY:?Set BOAT_API_KEY to your Boat API key}"
name=$1
image=$2
identity=$3
printf '%s\n' "$name" | LC_ALL=C grep -Eq '^[a-z0-9][a-z0-9-]{0,62}$' || { echo 'Invalid snapshot name' >&2; exit 2; }
case "$name" in latest|tree|pull|rm|save|current|self|new) echo 'Reserved snapshot name' >&2; exit 2;; esac
[ -f "$identity" ] && [ -f "$identity.pub" ] || { echo 'The SSH identity and its .pub file must exist' >&2; exit 2; }
work=$(mktemp -d)
sandbox=
api() {
  method=$1
  path=$2
  shift 2
  printf 'header = %s\n' "$(printf 'Authorization: Bearer %s' "$BOAT_API_KEY" | jq -Rs .)" |
    curl --silent --show-error --fail-with-body --max-time 60 --config - \
      -X "$method" -H 'Content-Type: application/json' "https://boat.dev/api/v1$path" "$@"
}
cleanup() {
  if [ -n "$sandbox" ]; then
    api DELETE "/sandboxes/$sandbox" -H "X-Ascii-Confirm-Delete: $sandbox" >/dev/null ||
      echo "Could not delete source sandbox $sandbox; delete it in Boat." >&2
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if command -v uuidgen >/dev/null 2>&1; then
  key=$(uuidgen)
else
  key=$(cat /proc/sys/kernel/random/uuid)
fi
api POST /sandboxes -H "Idempotency-Key: $key" --data \
  "$(jq -nc --arg name "usine-snapshot-$name" '{name:$name,noEnv:true,snapshots:true,monitoring:false,ttlSeconds:3600}')" > "$work/created.json"
sandbox=$(jq -er '.sandbox.id' "$work/created.json")
echo "Preparing source sandbox $sandbox" >&2
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
remote() {
  ssh -i "$identity" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    -o StrictHostKeyChecking=yes -o HostKeyAlias=usine-boat-snapshot \
    -o "UserKnownHostsFile=$work/known_hosts" "$user@$host" "$@"
}
tries=0
until remote true 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || { echo 'SSH readiness timed out' >&2; exit 1; }
  sleep 3
done
# The image is sent on stdin rather than interpolated into a remote shell command.
printf '%s\n' "$image" | remote 'sh -ec '\''
  IFS= read -r image
  curl -fsSL https://tailscale.com/install.sh -o /tmp/usine-install-tailscale.sh
  sudo sh /tmp/usine-install-tailscale.sh
  rm /tmp/usine-install-tailscale.sh
  sudo systemctl enable --now tailscaled
  test -c /dev/net/tun
  docker pull "$image"
  docker create --name usine-snapshot-image "$image"
  sudo systemctl stop tailscaled
  sudo rm -f /var/lib/tailscale/tailscaled.state
'\'''
echo "Saving snapshot $name; this can take several minutes" >&2
api POST /saved-snapshots --data "$(jq -nc --arg sandboxId "$sandbox" --arg name "$name" '{sandboxId:$sandboxId,name:$name}')" > "$work/saved.json"
tries=0
while :; do
  api GET "/saved-snapshots/$name" > "$work/snapshot.json"
  state=$(jq -er '.snapshot.status' "$work/snapshot.json")
  case "$state" in
    ready) echo "Snapshot $name is ready for $image"; break;;
    failed) echo "Saving snapshot $name failed" >&2; exit 1;;
    saving) ;;
    *) echo "Unknown snapshot state: $state" >&2; exit 1;;
  esac
  tries=$((tries + 1))
  [ "$tries" -lt 180 ] || { echo 'Snapshot save timed out; check its status in Boat' >&2; exit 1; }
  sleep 5
done
