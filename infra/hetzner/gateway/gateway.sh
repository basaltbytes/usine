#!/bin/sh
# Creates and deletes the usine gateway at Hetzner Cloud: a private network,
# the gateway VM, and its firewall, all labeled $LABEL.
#
#   ORCHESTRATOR_CIDR=203.0.113.7/32 SSH_KEY=my-key ./gateway.sh create
#   ./gateway.sh install -i ~/.ssh/usine_worker @usine/gateway                # the release on npm
#   pnpm --filter @usine/core --filter @usine/gateway pack                   # or a build: from the repository root, after pnpm build
#   ./gateway.sh install -i ~/.ssh/usine_worker ./usine-core-0.3.0.tgz ./usine-gateway-0.0.0.tgz
#   ./gateway.sh worker-user-data ~/.ssh/id_ed25519.pub > worker.mime        # cloud-init for a Worker behind it
#   ./gateway.sh delete
set -eu

here=$(cd "$(dirname "$0")" && pwd)
NAME=${NAME:-usine-gateway}
LOCATION=${LOCATION:-fsn1}
SERVER_TYPE=${SERVER_TYPE:-cx23}
IMAGE=${IMAGE:-debian-13}
NETWORK_ZONE=${NETWORK_ZONE:-eu-central}
NETWORK_CIDR=${NETWORK_CIDR:-10.42.0.0/16}
SUBNET_CIDR=${SUBNET_CIDR:-10.42.0.0/24}
GATEWAY_IP=${GATEWAY_IP:-10.42.0.2}
DOMAIN=${DOMAIN:-gw.internal}
LABEL=${LABEL:-usine=gateway}

encoded() {
  base64 | tr -d '\n'
}

render() {
  gateway_rules=$(sed "s|^define network = .*|define network = $NETWORK_CIDR|" "$here/gateway-nftables.conf" | encoded)
  worker_rules=$(sed "s|^define gateway = .*|define gateway = $GATEWAY_IP|" "$here/worker-nftables.conf" | encoded)
  allowlist=$(encoded < "$here/egress-allowlist")
  sed -e "s|@@DOMAIN@@|$DOMAIN|g" \
    -e "s|@@GATEWAY_IP@@|$GATEWAY_IP|g" \
    -e "s|@@GATEWAY_NFTABLES_B64@@|$gateway_rules|" \
    -e "s|@@WORKER_NFTABLES_B64@@|$worker_rules|" \
    -e "s|@@EGRESS_ALLOWLIST_B64@@|$allowlist|" \
    "$1"
}

create() {
  : "${ORCHESTRATOR_CIDR:?Set ORCHESTRATOR_CIDR to the address the orchestrator connects from, such as 203.0.113.7/32}"
  : "${SSH_KEY:?Set SSH_KEY to the names or ids of SSH keys in the hcloud project, separated by commas}"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  render "$here/gateway-cloud-init.yaml" > "$work/user-data.yaml"
  cat > "$work/rules.json" <<EOF
[
  {"direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["$ORCHESTRATOR_CIDR"], "description": "SSH from the orchestrator"},
  {"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ICMP"}
]
EOF
  hcloud network create --name "$NAME" --ip-range "$NETWORK_CIDR" --label "$LABEL"
  hcloud network add-subnet "$NAME" --type cloud --network-zone "$NETWORK_ZONE" --ip-range "$SUBNET_CIDR"
  hcloud firewall create --name "$NAME" --label "$LABEL" --rules-file "$work/rules.json"
  keys=$(printf '%s' "$SSH_KEY" | tr ',' '\n')
  set --
  while IFS= read -r key; do set -- "$@" --ssh-key "$key"; done <<EOF
$keys
EOF
  # Created stopped, so the private address is attached before cloud-init runs.
  hcloud server create --name "$NAME" --type "$SERVER_TYPE" --image "$IMAGE" --location "$LOCATION" \
    "$@" --firewall "$NAME" --label "$LABEL" \
    --user-data-from-file "$work/user-data.yaml" --start-after-create=false
  hcloud server attach-to-network "$NAME" --network "$NAME" --ip "$GATEWAY_IP"
  hcloud server poweron "$NAME"
  echo "Gateway $NAME is booting at $(hcloud server ip "$NAME"), $GATEWAY_IP on network $NAME."
  echo "Wait for it with: ssh root@$(hcloud server ip "$NAME") cloud-init status --wait"
  echo "Then install the gateway: $0 install [-i <identity-file>] (@usine/gateway[@<version>] | <tarball>...)"
}

# Runs scp or ssh with the identity file install was given, if any.
with_identity() {
  tool=$1
  shift
  if [ -n "$identity" ]; then "$tool" -i "$identity" -o IdentitiesOnly=yes "$@"; else "$tool" "$@"; fi
}

# Installs @usine/gateway from npm, or tarballs made with pnpm pack, which it
# copies to the gateway first. -i names the private key for scp and ssh, as
# with ssh -i.
install_packages() {
  identity=""
  if [ "${1:-}" = -i ]; then
    [ -f "${2:-}" ] || { echo "Pass an existing identity file after -i" >&2; exit 2; }
    identity=$2
    shift 2
  fi
  [ "$#" -gt 0 ] || { echo "Pass @usine/gateway, @usine/gateway@<version>, or the paths of tarballs made with pnpm pack" >&2; exit 2; }
  for package in "$@"; do
    case "$package" in
      *"'"*) echo "Not a package or a tarball: $package" >&2; exit 2 ;;
      @usine/gateway | @usine/gateway@*) ;;
      *) [ -f "$package" ] || { echo "No tarball at $package" >&2; exit 2; } ;;
    esac
  done
  remote=""
  # Leaves only the tarballs in "$@", so one scp copies them all.
  for package in "$@"; do
    shift
    case "$package" in
      @usine/gateway | @usine/gateway@*) remote="$remote '$package'" ;;
      *)
        set -- "$@" "$package"
        remote="$remote /root/$(basename "$package")"
        ;;
    esac
  done
  address=$(hcloud server ip "$NAME")
  [ "$#" -eq 0 ] || with_identity scp "$@" "root@$address:/root/"
  with_identity ssh "root@$address" "/usr/local/sbin/usine-gateway-install$remote"
}

# Prints a MIME multipart cloud-init for a Worker behind the gateway: the
# Worker file of ../cloud-init.yaml with the keys of $1 authorized for the
# usine user, then worker-cloud-init.yaml, whose lists cloud-init appends to
# the first file's.
worker_user_data() {
  [ -f "${1:-}" ] || { echo "Pass a file with the public keys to authorize for the usine user" >&2; exit 2; }
  keys=$(jq -Rsc 'split("\n") | map(select(length > 0 and (startswith("#") | not)))' < "$1")
  [ "$keys" != "[]" ] || { echo "No public key in $1" >&2; exit 2; }
  boundary=usine-worker-user-data
  printf 'Content-Type: multipart/mixed; boundary="%s"\nMIME-Version: 1.0\n\n' "$boundary"
  printf -- '--%s\nContent-Type: text/cloud-config; charset="utf-8"\nContent-Disposition: attachment; filename="cloud-init.yaml"\n\n' "$boundary"
  AUTHORIZED_KEYS=$keys awk '
    BEGIN { placeholder = "\"@AUTHORIZED_KEYS@\"" }
    (at = index($0, placeholder)) { $0 = substr($0, 1, at - 1) ENVIRON["AUTHORIZED_KEYS"] substr($0, at + length(placeholder)) }
    { print }
  ' "$here/../cloud-init.yaml"
  printf -- '--%s\nContent-Type: text/cloud-config; charset="utf-8"\nContent-Disposition: attachment; filename="worker-cloud-init.yaml"\nMerge-Type: list(append)+dict(no_replace,recurse_list)+str()\n\n' "$boundary"
  render "$here/worker-cloud-init.yaml"
  printf -- '--%s--\n' "$boundary"
}

delete() {
  if hcloud server describe "$NAME" > /dev/null 2>&1; then hcloud server delete "$NAME"; fi
  if hcloud firewall describe "$NAME" > /dev/null 2>&1; then hcloud firewall delete "$NAME"; fi
  if hcloud network describe "$NAME" > /dev/null 2>&1; then hcloud network delete "$NAME"; fi
}

command=${1:-}
[ "$#" -eq 0 ] || shift
case "$command" in
  create) create ;;
  install) install_packages "$@" ;;
  worker-user-data) worker_user_data "${1:-}" ;;
  delete) delete ;;
  *)
    echo "usage: $0 create | install [-i <identity-file>] (@usine/gateway[@<version>] | <tarball>...) | worker-user-data <public-key-file> | delete" >&2
    exit 2
    ;;
esac
