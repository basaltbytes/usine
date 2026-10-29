#!/bin/sh
# Creates and deletes the usine gateway at Hetzner Cloud: a private network,
# the gateway VM, and its firewall, all labeled $LABEL. apply, install, and tailnet-up
# connect to the SSH destination in $GATEWAY_SSH, such as a Host alias in
# ~/.ssh/config, or by default to root at the gateway's public address.
#
#   ORCHESTRATOR_CIDR=203.0.113.7/32 SSH_KEY=my-key ./gateway.sh create
#   ./gateway.sh tailnet-up -i ~/.ssh/usine_worker                           # log in to a tailnet with the URL it prints
#   TAILSCALE_AUTH_KEY=tskey-auth-... ./gateway.sh tailnet-up                # or with an auth key
#   GATEWAY_SSH=usine-gateway ./gateway.sh install @usine/gateway            # the release on npm, through a Host alias
#   ./gateway.sh install -i ~/.ssh/usine_worker @usine/gateway               # or through the public address
#   ./gateway.sh apply -i ~/.ssh/usine_worker --dry-run                     # preview host configuration changes
#   pnpm --filter @usine/core --filter @usine/gateway pack                   # or a build: from the repository root, after pnpm build
#   ./gateway.sh install -i ~/.ssh/usine_worker ./usine-core-0.3.0.tgz ./usine-gateway-0.0.0.tgz
#   ./gateway.sh worker-user-data ~/.ssh/id_ed25519.pub > worker.mime        # cloud-init for a Worker behind it
#   SSH_KEY=my-key ./gateway.sh orchestrator ~/.ssh/id_ed25519.pub            # the orchestrator's server in its network
#   ./gateway.sh orchestrator-tailnet-up -i ~/.ssh/usine_worker               # log it in to the tailnet and publish its UI
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
ORCHESTRATOR_NAME=${ORCHESTRATOR_NAME:-usine-orchestrator}
ORCHESTRATOR_TYPE=${ORCHESTRATOR_TYPE:-cpx12}
ORCHESTRATOR_LABEL=${ORCHESTRATOR_LABEL:-usine=orchestrator}
ORCHESTRATOR_TAG=${ORCHESTRATOR_TAG:-tag:usine-orchestrator}

encoded() {
  base64 | tr -d '\n'
}

render() {
  gateway_rules=$(sed "s|^define network = .*|define network = $NETWORK_CIDR|" "$here/gateway-nftables.conf" | encoded)
  worker_rules=$(sed "s|^define gateway = .*|define gateway = $GATEWAY_IP|" "$here/worker-nftables.conf" | encoded)
  orchestrator_rules=$(encoded < "$here/../orchestrator-nftables.conf")
  allowlist=$(encoded < "$here/egress-allowlist")
  # The orchestrator installs Tailscale with the signing key that the gateway's file pins.
  tailscale_key=$(sed -n '/BEGIN PGP PUBLIC KEY BLOCK/,/END PGP PUBLIC KEY BLOCK/s/^ *//p' "$here/gateway-cloud-init.yaml" | encoded)
  sed -e "s|@@DOMAIN@@|$DOMAIN|g" \
    -e "s|@@GATEWAY_IP@@|$GATEWAY_IP|g" \
    -e "s|@@NETWORK_CIDR@@|$NETWORK_CIDR|g" \
    -e "s|@@GATEWAY_NFTABLES_B64@@|$gateway_rules|" \
    -e "s|@@WORKER_NFTABLES_B64@@|$worker_rules|" \
    -e "s|@@ORCHESTRATOR_NFTABLES_B64@@|$orchestrator_rules|" \
    -e "s|@@EGRESS_ALLOWLIST_B64@@|$allowlist|" \
    -e "s|@@TAILSCALE_KEY_B64@@|$tailscale_key|" \
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
  echo "Then log it in to your tailnet: $0 tailnet-up [-i <identity-file>]"
  echo "Then install the gateway: $0 install [-i <identity-file>] (@usine/gateway[@<version>] | <tarball>...)"
}

# Sets destination to $GATEWAY_SSH, or to root at the gateway's public address.
gateway_destination() {
  if [ -n "${GATEWAY_SSH:-}" ]; then
    destination=$GATEWAY_SSH
  else
    destination=root@$(hcloud server ip "$NAME")
  fi
}

# Sets identity to the file after a leading -i, as with ssh -i, and skipped to
# the number of arguments the option takes.
identity_option() {
  identity=""
  skipped=0
  if [ "${1:-}" = -i ]; then
    [ -f "${2:-}" ] || { echo "Pass an existing identity file after -i" >&2; exit 2; }
    identity=$2
    skipped=2
  fi
}

# Runs scp or ssh with the identity file from identity_option, if any.
with_identity() {
  tool=$1
  shift
  if [ -n "$identity" ]; then "$tool" -i "$identity" -o IdentitiesOnly=yes "$@"; else "$tool" "$@"; fi
}

# Logs a host in to a tailnet under the name $1, with the further tailscale up
# flags in $2, and with the auth key in $TAILSCALE_AUTH_KEY, sent on standard
# input, or else with the login URL that tailscale up prints. Sets address to
# its tailnet IPv4 address. The other arguments are ssh's options and
# destination.
tailscale_up() {
  hostname=$1
  flags=$2
  shift 2
  up="tailscale up --hostname=$hostname --netfilter-mode=off --accept-dns=false$flags"
  if [ -n "${TAILSCALE_AUTH_KEY:-}" ]; then
    printf '%s' "$TAILSCALE_AUTH_KEY" | with_identity ssh "$@" "$up --auth-key=file:/dev/stdin"
  else
    with_identity ssh -t "$@" "$up"
  fi
  address=$(with_identity ssh "$@" tailscale ip -4)
}

# Logs the gateway in to a tailnet, then prints its tailnet IPv4 address.
tailnet_up() {
  identity_option "$@"
  shift "$skipped"
  [ "$#" -eq 0 ] || { echo "tailnet-up takes no arguments other than -i <identity-file>" >&2; exit 2; }
  gateway_destination
  tailscale_up "$NAME" "" "$destination"
  echo "Gateway $NAME is at $address on the tailnet."
}

# Installs @usine/gateway from npm, or tarballs made with pnpm pack, which it
# copies to the gateway first. -i names the private key for scp and ssh, as
# with ssh -i.
install_packages() {
  identity_option "$@"
  shift "$skipped"
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
  gateway_destination
  [ "$#" -eq 0 ] || with_identity scp "$@" "$destination:/root/"
  with_identity ssh "$destination" "/usr/local/sbin/usine-gateway-install$remote"
}

apply() {
  identity_option "$@"
  shift "$skipped"
  mode=apply
  if [ "${1:-}" = --dry-run ]; then mode=dry-run; shift; fi
  [ "$#" -eq 0 ] || { echo "apply takes [-i <identity-file>] [--dry-run]" >&2; exit 2; }
  gateway_destination
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  render "$here/gateway-cloud-init.yaml" > "$work/user-data.yaml"
  node "$here/apply.mjs" "$work/user-data.yaml" "$mode" "$destination" "$identity" "$0"
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
  "$here/../render-cloud-init.sh" "$keys"
  printf -- '--%s\nContent-Type: text/cloud-config; charset="utf-8"\nContent-Disposition: attachment; filename="worker-cloud-init.yaml"\nMerge-Type: list(append)+dict(no_replace,recurse_list)+str()\n\n' "$boundary"
  render "$here/worker-cloud-init.yaml"
  printf -- '--%s--\n' "$boundary"
}

# Prints the cloud-init of the orchestrator's server: ../orchestrator-cloud-init.yaml
# with the keys of $1 authorized for the usine user, and this gateway's settings.
orchestrator_user_data() {
  [ -f "${1:-}" ] || { echo "Pass a file with the public keys to authorize for the usine user" >&2; exit 2; }
  keys=$(jq -Rsc 'split("\n") | map(select(length > 0 and (startswith("#") | not)))' < "$1")
  [ "$keys" != "[]" ] || { echo "No public key in $1" >&2; exit 2; }
  "$here/../render-cloud-init.sh" "$keys" "$here/../orchestrator-cloud-init.yaml" | render /dev/stdin
}

# Prints the orchestrator's address in the gateway's network, its only network.
orchestrator_address() {
  hcloud server describe "$ORCHESTRATOR_NAME" -o json | jq -r '.private_net[0].ip'
}

# Creates the orchestrator's server in the gateway's network. It has public
# addresses for its own connections, and a firewall that admits only ICMP: its
# SSH and web UI are reachable over the tailnet, and its SSH over the private
# network until orchestrator-tailnet-up enables nftables.
orchestrator() {
  : "${SSH_KEY:?Set SSH_KEY to the names or ids of SSH keys in the hcloud project, for root, separated by commas}"
  [ "$#" -eq 1 ] || { echo "Pass a file with the public keys to authorize for the usine user" >&2; exit 2; }
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  orchestrator_user_data "$1" > "$work/user-data.yaml"
  echo '[{"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ICMP"}]' > "$work/rules.json"
  hcloud firewall create --name "$ORCHESTRATOR_NAME" --label "$ORCHESTRATOR_LABEL" --rules-file "$work/rules.json"
  keys=$(printf '%s' "$SSH_KEY" | tr ',' '\n')
  set --
  while IFS= read -r key; do set -- "$@" --ssh-key "$key"; done <<KEYS
$keys
KEYS
  hcloud server create --name "$ORCHESTRATOR_NAME" --type "$ORCHESTRATOR_TYPE" --image "$IMAGE" \
    --location "$LOCATION" "$@" --network "$NAME" --firewall "$ORCHESTRATOR_NAME" \
    --label "$ORCHESTRATOR_LABEL" --user-data-from-file "$work/user-data.yaml"
  address=$(orchestrator_address)
  echo "Orchestrator $ORCHESTRATOR_NAME is booting at $address on network $NAME."
  echo "Wait for it with: ssh -J <gateway> root@$address cloud-init status --wait"
  echo "Then log it in to your tailnet: $0 orchestrator-tailnet-up [-i <identity-file>]"
}

# Logs the orchestrator in to a tailnet with the tag $ORCHESTRATOR_TAG, over SSH
# to root through the gateway, and publishes the web UI with tailscale serve.
# Then enables nftables, which from then on refuses SSH from the private
# network, and prints the server's tailnet address and the UI's URL.
orchestrator_tailnet_up() {
  identity_option "$@"
  shift "$skipped"
  [ "$#" -eq 0 ] || { echo "orchestrator-tailnet-up takes no arguments other than -i <identity-file>" >&2; exit 2; }
  gateway_destination
  if [ -n "$identity" ]; then
    jump="ProxyCommand=ssh -i $identity -o IdentitiesOnly=yes -W %h:%p $destination"
  else
    jump="ProxyJump=$destination"
  fi
  root="root@$(orchestrator_address)"
  tailscale_up "$ORCHESTRATOR_NAME" " --advertise-tags=$ORCHESTRATOR_TAG" -o "$jump" "$root"
  # HTTPS at the server's tailnet name, proxied to usine up's default port on 127.0.0.1, also after a reboot.
  with_identity ssh -t -o "$jump" "$root" tailscale serve --bg 7331
  url=$(with_identity ssh -o "$jump" "$root" tailscale status --json | jq -r '"https://" + (.Self.DNSName | rtrimstr("."))')
  with_identity ssh -o "$jump" "$root" systemctl enable --now nftables
  echo "Orchestrator $ORCHESTRATOR_NAME is at $address on the tailnet, and serves the web UI at $url."
  echo "nftables now refuses SSH from the private network: connect to the server over the tailnet."
  echo "Add USINE_ORIGIN=$url to /home/usine/factory/.env, so that the UI's pages there can use the operator API."
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
  tailnet-up) tailnet_up "$@" ;;
  install) install_packages "$@" ;;
  apply) apply "$@" ;;
  worker-user-data) worker_user_data "${1:-}" ;;
  orchestrator) orchestrator "$@" ;;
  orchestrator-user-data) orchestrator_user_data "${1:-}" ;;
  orchestrator-tailnet-up) orchestrator_tailnet_up "$@" ;;
  delete) delete ;;
  *)
    echo "usage: $0 create | apply [-i <identity-file>] [--dry-run] | tailnet-up [-i <identity-file>] | install [-i <identity-file>] (@usine/gateway[@<version>] | <tarball>...) | worker-user-data <public-key-file> | orchestrator <public-key-file> | orchestrator-user-data <public-key-file> | orchestrator-tailnet-up [-i <identity-file>] | delete" >&2
    exit 2
    ;;
esac
