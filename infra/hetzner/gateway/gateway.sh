#!/bin/sh
# Creates and deletes the usine gateway at Hetzner Cloud: a private network,
# the gateway VM, and its firewall, all labeled $LABEL.
#
#   ORCHESTRATOR_CIDR=203.0.113.7/32 SSH_KEY=my-key ./gateway.sh create
#   ./gateway.sh install ./usine-gateway-0.1.0.tgz   # an unpublished build
#   ./gateway.sh worker-user-data > worker.yaml      # cloud-init for a Worker behind it
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
GATEWAY_PACKAGE=${GATEWAY_PACKAGE:-@usine/gateway}

encoded() {
  base64 | tr -d '\n'
}

render() {
  gateway_rules=$(sed "s|^define network = .*|define network = $NETWORK_CIDR|" "$here/gateway-nftables.conf" | encoded)
  worker_rules=$(sed "s|^define gateway = .*|define gateway = $GATEWAY_IP|" "$here/worker-nftables.conf" | encoded)
  allowlist=$(encoded < "$here/egress-allowlist")
  sed -e "s|@@DOMAIN@@|$DOMAIN|g" \
    -e "s|@@GATEWAY_IP@@|$GATEWAY_IP|g" \
    -e "s|@@GATEWAY_PACKAGE@@|$GATEWAY_PACKAGE|g" \
    -e "s|@@GATEWAY_NFTABLES_B64@@|$gateway_rules|" \
    -e "s|@@WORKER_NFTABLES_B64@@|$worker_rules|" \
    -e "s|@@EGRESS_ALLOWLIST_B64@@|$allowlist|" \
    "$1"
}

create() {
  : "${ORCHESTRATOR_CIDR:?Set ORCHESTRATOR_CIDR to the address the orchestrator connects from, such as 203.0.113.7/32}"
  : "${SSH_KEY:?Set SSH_KEY to the name of an SSH key in the hcloud project}"
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
  # Created stopped, so the private address is attached before cloud-init runs.
  hcloud server create --name "$NAME" --type "$SERVER_TYPE" --image "$IMAGE" --location "$LOCATION" \
    --ssh-key "$SSH_KEY" --firewall "$NAME" --label "$LABEL" \
    --user-data-from-file "$work/user-data.yaml" --start-after-create=false
  hcloud server attach-to-network "$NAME" --network "$NAME" --ip "$GATEWAY_IP"
  hcloud server poweron "$NAME"
  echo "Gateway $NAME is booting at $(hcloud server ip "$NAME"), $GATEWAY_IP on network $NAME."
  echo "Wait for it with: ssh root@$(hcloud server ip "$NAME") cloud-init status --wait"
}

install_package() {
  : "${1:?Pass the path of a tarball made with pnpm pack}"
  address=$(hcloud server ip "$NAME")
  scp "$1" "root@$address:/root/usine-gateway.tgz"
  ssh "root@$address" /usr/local/sbin/usine-gateway-install /root/usine-gateway.tgz
}

delete() {
  if hcloud server describe "$NAME" > /dev/null 2>&1; then hcloud server delete "$NAME"; fi
  if hcloud firewall describe "$NAME" > /dev/null 2>&1; then hcloud firewall delete "$NAME"; fi
  if hcloud network describe "$NAME" > /dev/null 2>&1; then hcloud network delete "$NAME"; fi
}

case "${1:-}" in
  create) create ;;
  install) install_package "${2:-}" ;;
  worker-user-data) render "$here/worker-cloud-init.yaml" ;;
  delete) delete ;;
  *)
    echo "usage: $0 create | install <tarball> | worker-user-data | delete" >&2
    exit 2
    ;;
esac
