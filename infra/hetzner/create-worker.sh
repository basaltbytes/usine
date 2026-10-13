#!/usr/bin/env bash
# Creates one usine SSH Worker on Hetzner Cloud with the active hcloud context:
# a server built from cloud-init.yaml, and a firewall that admits SSH from the
# orchestrator's address only.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: create-worker.sh <name> <location> <orchestrator-ip> <public-key-file>

  name              server name and usine Worker name, kebab-case
  location          fsn1 (Falkenstein), nbg1 (Nuremberg), or hel1 (Helsinki)
  orchestrator-ip   the IPv4 address the orchestrator connects from
  public-key-file   the orchestrator's SSH public key, authorized for the usine user

Environment:
  HCLOUD_SERVER_TYPE  server type, default cpx32
  HCLOUD_IMAGE        image, default debian-13
  USINE_LABEL         value of the usine label on every resource, default worker
EOF
  exit 64
}

[ "$#" -eq 4 ] || usage
name=$1
location=$2
orchestrator_ip=$3
public_key_file=$4
server_type=${HCLOUD_SERVER_TYPE:-cpx32}
image=${HCLOUD_IMAGE:-debian-13}
label=${USINE_LABEL:-worker}
here=$(cd "$(dirname "$0")" && pwd)

[[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "Worker name must be kebab-case: $name" >&2; exit 64; }
case "$location" in fsn1 | nbg1 | hel1) ;; *) echo "Location must be fsn1, nbg1, or hel1: $location" >&2; exit 64 ;; esac
[[ "$orchestrator_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "Expected an IPv4 address: $orchestrator_ip" >&2; exit 64; }
[ -f "$public_key_file" ] || { echo "No public key at $public_key_file" >&2; exit 66; }
[[ "$label" =~ ^[a-z0-9-]+$ ]] || { echo "USINE_LABEL must be lowercase letters, digits, and dashes" >&2; exit 64; }

public_key=$(head -n 1 "$public_key_file")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
user_data=$(<"$here/cloud-init.yaml")
printf '%s\n' "${user_data//@AUTHORIZED_KEY@/$public_key}" > "$work/user-data.yaml"

# Hetzner emails a root password for a server created without an SSH key, so
# the same public key is registered once and reused.
fingerprint=$(ssh-keygen -l -E md5 -f "$public_key_file" | awk '{ sub(/^MD5:/, "", $2); print $2 }')
ssh_key=$(hcloud ssh-key list -o noheader -o columns=id,fingerprint | awk -v fp="$fingerprint" '$2 == fp { print $1 }')
if [ -z "$ssh_key" ]; then
  ssh_key=$(hcloud ssh-key create --name "usine-$name" --public-key-from-file "$public_key_file" \
    --label "usine=$label" -o json | jq -r '.ssh_key.id')
  echo "Registered the public key as SSH key usine-$name"
fi

cat > "$work/firewall.json" <<EOF
[
  {
    "direction": "in",
    "protocol": "tcp",
    "port": "22",
    "source_ips": ["$orchestrator_ip/32"],
    "description": "SSH from the usine orchestrator"
  }
]
EOF
hcloud firewall create --name "usine-$name" --label "usine=$label" --rules-file "$work/firewall.json" >/dev/null
echo "Created firewall usine-$name: inbound SSH from $orchestrator_ip only"

hcloud server create \
  --name "$name" \
  --type "$server_type" \
  --image "$image" \
  --location "$location" \
  --ssh-key "$ssh_key" \
  --firewall "usine-$name" \
  --label "usine=$label" \
  --user-data-from-file "$work/user-data.yaml" >/dev/null

address=$(hcloud server ip "$name")
cat <<EOF
Created server $name ($server_type, $image, $location) at $address.

cloud-init installs the toolchain in a minute or two. Connect once to record the
host key and wait for it to finish:

  ssh -i ${public_key_file%.pub} usine@$address cloud-init status --wait

Then log in to the harnesses as the usine user and add the Worker to usine.yaml
(see infra/hetzner/README.md).
EOF
