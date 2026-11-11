#!/bin/sh
# Captures the runtime, attempt image, and empty Tailscale state.
# The tests in test/ cover the CLI calls with fakes; a real build is the acceptance test.
set -eu
usage() { echo "Usage: $0 [--size <vcpu>x<GiB>] <snapshot-name>" >&2; exit 2; }
size=2x8
if [ "${1:-}" = --size ]; then [ "$#" -ge 2 ] || usage; size=$2; shift 2; fi
[ "$#" -eq 1 ] || usage
name=$1
# Positive whole numbers of vCPUs and GiB, without leading zeros.
case "$size" in ''|*[!0-9x]*|0*|x*|*x|*x0*|*x*x*) usage;; *x*) ;; *) usage;; esac
printf '%s\n' "$name" | LC_ALL=C grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' || usage
here=$(cd "$(dirname "$0")" && pwd)
image=${ATTEMPT_IMAGE:-ghcr.io/basaltbytes/usine-worker:$(cat "$here/../worker-image/tag.txt")}
runtime=${USINE_CONTAINER_RUNTIME:-docker}
case "$runtime" in docker|podman) ;; *) echo 'Invalid USINE_CONTAINER_RUNTIME' >&2; exit 2;; esac
case "$image" in ''|*[!A-Za-z0-9./:@_-]*) echo 'Invalid ATTEMPT_IMAGE' >&2; exit 2;; esac
machine=usine-snapshot-$(date -u +%Y%m%d%H%M%S)-$$
created=false
cleanup() {
  if [ "$created" = true ]; then
    boxd machine remove -y "$machine" </dev/null >/dev/null || echo "Delete temporary machine $machine in boxd" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The CLI uses its linked device key for this initial connection and pins the proxy key.
boxd machine new "$machine" --vcpu "${size%%x*}" --memory "${size#*x}" --isolated --auto-hibernate-timeout 0 --json </dev/null >/dev/null
created=true
echo "Created temporary machine $machine" >&2
tries=0
until ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$machine.boxd" true 2>/dev/null; do
  tries=$((tries + 1)); [ "$tries" -lt 60 ] || { echo 'SSH readiness timed out' >&2; exit 1; }
  sleep 2
done
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$machine.boxd" "sh -s -- '$runtime' '$image'" <<'REMOTE'
# boxd serves SSH through its proxy and exec agent, so sshd configuration in the machine has no effect.
# Variables sent with SendEnv don't arrive in the machine; see #1101.
set -eu
runtime=$1
image=$2
sudo install -d -m 0755 /etc/usine
printf '%s\n' "$runtime" | sudo tee /etc/usine/container-runtime >/dev/null
install -d -m 0700 /home/boxd/.usine /home/boxd/.cache/turbo
if [ "$runtime" = podman ]; then
  sudo apt-get update
  sudo apt-get install -y podman crun uidmap dbus-user-session slirp4netns fuse-overlayfs
  sudo loginctl enable-linger boxd
  sudo systemctl start "user@$(id -u).service"
  export XDG_RUNTIME_DIR=/run/user/$(id -u)
fi
"$runtime" pull "$image"
"$runtime" volume create usine-pnpm-store >/dev/null
"$runtime" volume create usine-turbo-cache >/dev/null
curl -fsSL https://tailscale.com/install.sh -o /tmp/usine-tailscale.sh
sudo sh /tmp/usine-tailscale.sh
rm /tmp/usine-tailscale.sh
sudo systemctl enable tailscaled
sudo systemctl stop tailscaled
sudo rm -f /var/lib/tailscale/tailscaled.state
sync
REMOTE
boxd snapshots save "$machine" "$name" </dev/null >&2
# A successful save is ready before the source machine is removed.
printf '%s\n' "$name"
