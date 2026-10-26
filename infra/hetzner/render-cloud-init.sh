#!/bin/sh
# Prints cloud-init.yaml with "@AUTHORIZED_KEYS@" replaced by $1, a JSON list
# of the public keys to authorize for the usine user, and @NODE_MAJOR@ by
# NODE_MAJOR of ../worker-image/Dockerfile, the Node.js major version of the
# attempt image. create-worker.sh, snapshot.sh, and
# `gateway/gateway.sh worker-user-data` send the result as user data.
#
#   ./render-cloud-init.sh '["ssh-ed25519 AAAA... orchestrator"]' > user-data.yaml
set -eu

[ "$#" -eq 1 ] || { echo "Usage: render-cloud-init.sh <JSON list of public keys>" >&2; exit 64; }
here=$(cd "$(dirname "$0")" && pwd)
dockerfile=$here/../worker-image/Dockerfile
node_major=$(sed -n 's/^ARG NODE_MAJOR=//p' "$dockerfile")
case "$node_major" in
  '' | *[!0-9]*) echo "Expected one ARG NODE_MAJOR=<major version> line in $dockerfile" >&2; exit 1 ;;
esac

# Comment lines keep their placeholders.
AUTHORIZED_KEYS=$1 NODE_MAJOR=$node_major awk '
  BEGIN { placeholder = "\"@AUTHORIZED_KEYS@\"" }
  /^[[:space:]]*#/ { print; next }
  (at = index($0, placeholder)) { $0 = substr($0, 1, at - 1) ENVIRON["AUTHORIZED_KEYS"] substr($0, at + length(placeholder)) }
  { gsub(/@NODE_MAJOR@/, ENVIRON["NODE_MAJOR"]); print }
' "$here/cloud-init.yaml"
