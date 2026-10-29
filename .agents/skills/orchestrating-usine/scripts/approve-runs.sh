#!/usr/bin/env bash
# approve-runs.sh [--loop NAME] ISSUE... Approves waiting runs for the given item numbers as their
# approval entries appear, for up to 3 minutes. A need with no item is listed for approval by run id.
. "$(dirname "$0")/lib.sh"
loop=""
if [ "${1:-}" = "--loop" ]; then loop="$2"; shift 2; fi
want=("$@")
[ ${#want[@]} -gt 0 ] || { echo "usage: approve-runs.sh [--loop NAME] ISSUE..." >&2; exit 2; }
for _ in $(seq 1 18); do
  ov=$(usine_api GET /api/overview)
  rest=()
  for n in "${want[@]}"; do
    rid=$(echo "$ov" | LOOP="$loop" N="$n" py -c '
import json, os, sys
o = json.load(sys.stdin)
for x in o.get("needsYou", []):
    if x.get("_tag") != "ApprovalNeed": continue
    if os.environ["LOOP"] and x.get("loop") != os.environ["LOOP"]: continue
    if str((x.get("item") or {}).get("number")) == os.environ["N"]:
        print(x["runId"]); break')
    if [ -n "$rid" ]; then
      code=$(usine_api POST "/api/runs/$rid/approve" '{}' -o /dev/null -w '%{http_code}' 2>/dev/null || true)
      echo "approved #$n $rid"
    else
      rest+=("$n")
    fi
  done
  want=("${rest[@]}")
  [ ${#want[@]} -eq 0 ] && exit 0
  sleep 10
done
echo "still waiting: ${want[*]}"
echo "$ov" | py -c '
import json, sys
o = json.load(sys.stdin)
for x in o.get("needsYou", []):
    if x.get("_tag") == "ApprovalNeed" and not x.get("item"):
        print("approval with no item: run", x["runId"], "loop", x.get("loop"))'
