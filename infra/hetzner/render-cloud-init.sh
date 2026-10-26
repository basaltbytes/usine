#!/bin/sh
# Prints cloud-init.yaml with "@AUTHORIZED_KEYS@" replaced by $1, a JSON list
# of the public keys to authorize for the usine user. create-worker.sh,
# snapshot.sh, and `gateway/gateway.sh worker-user-data` send the result as
# user data.
#
#   ./render-cloud-init.sh '["ssh-ed25519 AAAA... orchestrator"]' > user-data.yaml
set -eu

[ "$#" -eq 1 ] || { echo "Usage: render-cloud-init.sh <JSON list of public keys>" >&2; exit 64; }
here=$(cd "$(dirname "$0")" && pwd)

AUTHORIZED_KEYS=$1 awk '
  BEGIN { placeholder = "\"@AUTHORIZED_KEYS@\"" }
  (at = index($0, placeholder)) { $0 = substr($0, 1, at - 1) ENVIRON["AUTHORIZED_KEYS"] substr($0, at + length(placeholder)) }
  { print }
' "$here/cloud-init.yaml"
