#!/usr/bin/env bash
# usine-api.sh METHOD PATH [JSON-BODY]
# Example: usine-api.sh POST /api/runs/abc/approve '{}'
. "$(dirname "$0")/lib.sh"
[ $# -ge 2 ] || { echo "usage: usine-api.sh METHOD PATH [JSON]" >&2; exit 2; }
usine_api "$@"
echo
