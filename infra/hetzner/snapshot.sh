#!/bin/sh
# Builds the Hetzner Cloud snapshot of a provisioned usine Worker with the
# active hcloud context: a temporary server from cloud-init.yaml, or from
# `gateway/gateway.sh worker-user-data` in the gateway's network, with the
# attempt image pulled. Saves it as a snapshot labeled usine=snapshot, deletes
# the server, and prints the snapshot for provisioner.image in usine.yaml.
#
#   SSH_KEY=usine-worker ./snapshot.sh ~/.ssh/usine_worker.pub
#   SSH_KEY=usine-worker NETWORK=usine-gateway GATEWAY_SSH=usine-gateway ./snapshot.sh ~/.ssh/usine_worker.pub
set -eu

usage() {
  cat >&2 <<'EOF'
Usage: snapshot.sh <public-key-file>

  public-key-file  the public key of the worker's identity_file, authorized for
                   the usine user; its private key must be next to it

Environment:
  SSH_KEY        name or ID of the project's SSH key for the temporary server, required
  LOCATION       location of the temporary server, default fsn1
  SERVER_TYPE    type of the temporary server, default cx23; servers created from
                 the snapshot need a disk at least as large as this type's
  IMAGE          base image, default debian-13
  NETWORK        the gateway's network; builds the snapshot behind the gateway
  GATEWAY_SSH    the gateway's SSH destination, such as its Host alias; required with NETWORK
  ATTEMPT_IMAGE  the attempt image to pull, default ATTEMPT_IMAGE in
                 packages/executor/src/ssh/container.ts
  DESCRIPTION    the snapshot's description, default usine-worker-<attempt image tag>
  SERVER_NAME    name of the temporary server, default usine-snapshot-<time>

Behind the gateway, gateway.sh reads GATEWAY_IP, DOMAIN, and NETWORK_CIDR as
for gateway.sh create.
EOF
  exit 64
}

[ "$#" -eq 1 ] || usage
public_key_file=$1
here=$(cd "$(dirname "$0")" && pwd)
: "${SSH_KEY:?Set SSH_KEY to the name or ID of an SSH key in the hcloud project}"
LOCATION=${LOCATION:-fsn1}
SERVER_TYPE=${SERVER_TYPE:-cx23}
IMAGE=${IMAGE:-debian-13}
NETWORK=${NETWORK:-}
SERVER_NAME=${SERVER_NAME:-usine-snapshot-$(date -u +%Y%m%d%H%M%S)}
ATTEMPT_IMAGE=${ATTEMPT_IMAGE:-$(grep -o 'ghcr\.io/basaltbytes/usine-worker:[A-Za-z0-9._-]*' "$here/../../packages/executor/src/ssh/container.ts" | head -n 1)}
DESCRIPTION=${DESCRIPTION:-usine-worker-${ATTEMPT_IMAGE##*:}}
identity=${public_key_file%.pub}

[ -f "$public_key_file" ] || { echo "No public key at $public_key_file" >&2; exit 66; }
[ -f "$identity" ] || { echo "No private key at $identity, next to $public_key_file" >&2; exit 66; }
case "$ATTEMPT_IMAGE" in
  '' | *[!A-Za-z0-9./:@_-]*) echo "Set ATTEMPT_IMAGE to an image reference, such as ghcr.io/basaltbytes/usine-worker:<tag>" >&2; exit 64 ;;
esac
if [ -n "$NETWORK" ]; then
  : "${GATEWAY_SSH:?Set GATEWAY_SSH to the SSH destination of the gateway, such as its Host alias usine-gateway}"
fi

work=$(mktemp -d)
cleanup() {
  status=$?
  if hcloud server describe "$SERVER_NAME" > /dev/null 2>&1; then
    hcloud server delete "$SERVER_NAME" > /dev/null && echo "Deleted the temporary server $SERVER_NAME" >&2
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

if [ -z "$NETWORK" ]; then
  AUTHORIZED_KEYS=$(head -n 1 "$public_key_file" | jq -Rc '[.]') awk '
    BEGIN { placeholder = "\"@AUTHORIZED_KEYS@\"" }
    (at = index($0, placeholder)) { $0 = substr($0, 1, at - 1) ENVIRON["AUTHORIZED_KEYS"] substr($0, at + length(placeholder)) }
    { print }
  ' "$here/cloud-init.yaml" > "$work/user-data"
  set -- --without-ipv6
else
  "$here/gateway/gateway.sh" worker-user-data "$public_key_file" > "$work/user-data"
  set -- --network "$NETWORK" --without-ipv4 --without-ipv6
fi

hcloud server create --name "$SERVER_NAME" --type "$SERVER_TYPE" --image "$IMAGE" --location "$LOCATION" \
  --ssh-key "$SSH_KEY" --label usine=snapshot-build --user-data-from-file "$work/user-data" "$@" > /dev/null
if [ -z "$NETWORK" ]; then
  address=$(hcloud server ip "$SERVER_NAME")
else
  address=$(hcloud server describe "$SERVER_NAME" -o json | jq -r '.private_net[0].ip')
fi

# Runs a command as usine on the temporary server, which gets a known-hosts file of its own.
# Exits with 255 if the connection fails, or stops answering for about a minute.
remote() {
  if [ -n "$NETWORK" ]; then set -- -J "$GATEWAY_SSH" "$@"; fi
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    -i "$identity" -o IdentitiesOnly=yes \
    -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=accept-new "$@"
}

wait_minutes=20
deadline=$(($(date +%s) + wait_minutes * 60))
echo "Created $SERVER_NAME ($SERVER_TYPE, $IMAGE, $LOCATION) at $address. Waiting up to $wait_minutes minutes for SSH and cloud-init, which take a few minutes." >&2
until remote "usine@$address" true 2> /dev/null; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "$SERVER_NAME didn't accept SSH as usine within $wait_minutes minutes" >&2; exit 1; }
  sleep 10
done
# cloud-init loads the server's nftables rules at the end of its run, which can drop the connection that waits for it.
while :; do
  remaining=$((deadline - $(date +%s)))
  [ "$remaining" -gt 0 ] || { waited=124; break; }
  waited=0
  remote "usine@$address" timeout "$remaining" cloud-init status --wait > /dev/null || waited=$?
  [ "$waited" -eq 255 ] || break
  echo "Lost the SSH connection to $SERVER_NAME while waiting for cloud-init; reconnecting" >&2
  sleep 10
done
case "$waited" in
  0) ;;
  2) echo "cloud-init finished with recoverable errors on $SERVER_NAME" >&2 ;;
  *)
    remote "usine@$address" 'cloud-init status --long; tail -n 40 /var/log/cloud-init-output.log' >&2 || true
    case "$waited" in
      124) echo "cloud-init didn't finish on $SERVER_NAME within $wait_minutes minutes" >&2 ;;
      *) echo "cloud-init failed on $SERVER_NAME" >&2 ;;
    esac
    exit 1
    ;;
esac

remote "usine@$address" docker version > /dev/null || { echo "Docker doesn't answer the usine user on $SERVER_NAME" >&2; exit 1; }
echo "Pulling $ATTEMPT_IMAGE" >&2
remote "usine@$address" docker pull --quiet "$ATTEMPT_IMAGE" > /dev/null
remote "usine@$address" docker image inspect "$ATTEMPT_IMAGE" > /dev/null || { echo "$ATTEMPT_IMAGE isn't on $SERVER_NAME after the pull" >&2; exit 1; }

hcloud server shutdown --wait --wait-timeout 2m "$SERVER_NAME" > /dev/null || hcloud server poweroff "$SERVER_NAME" > /dev/null
echo "Creating the snapshot $DESCRIPTION, which takes a few minutes" >&2
hcloud server create-image --type snapshot --description "$DESCRIPTION" --label usine=snapshot "$SERVER_NAME" > /dev/null
snapshot=$(hcloud image list --type snapshot --selector usine=snapshot -o json |
  jq -r --arg server "$SERVER_NAME" --arg description "$DESCRIPTION" \
    '[.[] | select(.created_from.name == $server and .description == $description)] | sort_by(.created) | last | .id')
hcloud server delete "$SERVER_NAME" > /dev/null

cat <<EOF
Created snapshot $snapshot, "$DESCRIPTION", with $ATTEMPT_IMAGE pulled.

Set it in the worker's provisioner in usine.yaml, by description or ID:

  image: $DESCRIPTION

With a description, usine creates each server from the newest available
snapshot that has it.
EOF
