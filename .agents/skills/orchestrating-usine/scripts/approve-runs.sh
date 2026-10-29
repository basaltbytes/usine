#!/usr/bin/env bash
# approve-runs.sh [--loop NAME] [--repo OWNER/NAME] ISSUE... Approves waiting runs for the given item
# numbers as their approval entries appear, for up to 3 minutes. Items are matched on repository and
# number; --repo is required when env.sh lists more than one repository. A need matched by more than
# one entry is skipped. A need with no item is listed for approval by run id.
. "$(dirname "$0")/lib.sh"
loop=""; repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --loop) loop="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    *) break ;;
  esac
done
if [ -z "$repo" ]; then
  set -- $USINE_REPOS "$@"
  repo_count=0; for r in $USINE_REPOS; do repo_count=$((repo_count + 1)); done
  if [ "$repo_count" -eq 1 ]; then repo="$USINE_REPOS"; shift 1; else
    echo "env.sh lists $repo_count repositories; pass --repo OWNER/NAME" >&2; exit 2
  fi
fi
want=("$@")
[ ${#want[@]} -gt 0 ] || { echo "usage: approve-runs.sh [--loop NAME] [--repo OWNER/NAME] ISSUE..." >&2; exit 2; }
for _ in $(seq 1 18); do
  ov=$(usine_api GET /api/overview)
  rest=()
  for n in "${want[@]}"; do
    rid=$(echo "$ov" | LOOP="$loop" REPO="$repo" N="$n" py -c '
import json, os, sys
o = json.load(sys.stdin)
hits = [x for x in o.get("needsYou", [])
        if x.get("_tag") == "ApprovalNeed"
        and x.get("repository") == os.environ["REPO"]
        and (not os.environ["LOOP"] or x.get("loop") == os.environ["LOOP"])
        and str((x.get("item") or {}).get("number")) == os.environ["N"]]
if len(hits) == 1:
    print(hits[0]["runId"])
elif len(hits) > 1:
    print("AMBIGUOUS " + " ".join(h["runId"] for h in hits))')
    case "$rid" in
      "") rest+=("$n") ;;
      AMBIGUOUS*) echo "skipping #$n: several approvals match, approve by run id: ${rid#AMBIGUOUS }" ;;
      *)
        if usine_api POST "/api/runs/$rid/approve" '{}' >/dev/null; then
          echo "approved $repo#$n $rid"
        else
          echo "approve failed for $repo#$n $rid" >&2; rest+=("$n")
        fi ;;
    esac
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
