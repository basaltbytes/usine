#!/usr/bin/env bash
# Prints what the overseer needs each pass: Needs attention, running attempts, stalled items,
# workers, upgrade state, open agent PRs, failed default-branch workflows, recent server errors.
. "$(dirname "$0")/lib.sh"

echo "## $(date -u +%Y-%m-%dT%H:%MZ) $USINE_URL"
version=$(usine_api GET /api/version 2>/dev/null || echo '"unreachable"')
echo "version: $version"

ov=$(usine_api GET /api/overview 2>/dev/null || true)
if [ -z "$ov" ]; then
  echo "overview unreachable"
else
  echo "$ov" | py -c '
import json, sys
o = json.load(sys.stdin)
needs = o.get("needsYou", [])
print("\n### Needs attention (%d)" % len(needs))
for n in needs:
    item = n.get("item") or {}
    label = "#%s %s" % (item.get("number"), (item.get("title") or "")[:60]) if item else n.get("itemLabel", "")
    detail = ""
    if n["_tag"] == "RunFailureNeed":
        detail = (n.get("failure") or {}).get("_tag", "")
    if n["_tag"] == "CycleBudgetNeed":
        detail = "askId=" + str((n.get("ask") or {}).get("id"))
    print("- %s %s %s run=%s %s" % (n["_tag"], n.get("loop", ""), label, (n.get("runId") or "")[:8], detail))
paused = [l["name"] for l in o.get("loops", []) if l.get("paused")]
if paused:
    print("\npaused loops:", ", ".join(paused))
'
fi

desk=$(usine_api GET /api/desk 2>/dev/null || true)
if [ -n "$desk" ]; then
  echo "$desk" | py -c '
import json, sys
d = json.load(sys.stdin)
running = d.get("running", [])
print("\n### Running (%d)" % len(running))
for r in running:
    run, att, item = r["run"], r["attempt"], r.get("item") or {}
    warn = " ".join(w["_tag"] for w in r.get("warnings", []))
    print("- %s #%s %s on %s since %s last activity %s %s" % (run["loop"], item.get("number", "?"), (item.get("title") or "")[:50], att["worker"], att["startedAt"][11:16], (r.get("lastActivityAt") or "")[11:16], warn))
stalled = d.get("notMoving", [])
print("\n### Stalled (%d)" % len(stalled))
for s in stalled:
    item = s["item"]
    print("- %s #%s %s: %s" % (s["loop"], item.get("number"), (item.get("title") or "")[:50], s["reason"]["_tag"]))
print("\n### Workers")
for w in d.get("workers", []):
    pf = w.get("preflight") or {}
    print("- %s %s/%s %s" % (w["name"], w["slots"]["leased"], w["slots"]["capacity"], pf.get("_tag") or pf.get("status") or ""))
'
fi

up=$(usine_api GET /api/upgrade 2>/dev/null || true)
[ -n "$up" ] && echo "$up" | py -c '
import json, sys
u = json.load(sys.stdin)
if u.get("available") or u.get("phase") != "idle":
    print("\n### Upgrade\n- running %s, available %s, phase %s %s" % (u.get("running"), u.get("available"), u.get("phase"), u.get("message") or ""))
'

if [ -n "$USINE_REPOS" ]; then
  echo
  echo "### Open agent PRs"
  for repo in $USINE_REPOS; do
    author=()
    [ -n "$USINE_APP" ] && author=(--author "$USINE_APP")
    # App-authored PRs plus any PR carrying a loop label (fast-lane PRs by the operator). The CI
    # summary makes a check completion a visible change for wait-change.sh.
    {
      gh pr list -R "$repo" "${author[@]}" --state open --json number,title,labels,mergeable,isDraft,statusCheckRollup 2>/dev/null
      for label in ready-for-review ready-to-merge agent-review-findings; do
        gh pr list -R "$repo" --label "$label" --state open --json number,title,labels,mergeable,isDraft,statusCheckRollup 2>/dev/null
      done
    } | python3 -I -c '
import json, sys
seen = {}
text = sys.stdin.read()
decoder = json.JSONDecoder()
pos = 0
while True:
    while pos < len(text) and text[pos].isspace():
        pos += 1
    if pos >= len(text):
        break
    prs, pos = decoder.raw_decode(text, pos)
    for pr in prs:
        seen.setdefault(pr["number"], pr)
if not seen:
    print("- none")
for n in sorted(seen):
    pr = seen[n]
    checks = pr.get("statusCheckRollup") or []
    if any(c.get("status") != "COMPLETED" for c in checks):
        ci = "ci=pending"
    elif any((c.get("conclusion") or "") in ("FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED") for c in checks):
        ci = "ci=failed"
    elif checks:
        ci = "ci=green"
    else:
        ci = "ci=none"
    labels = ",".join(l["name"] for l in pr.get("labels") or [])
    draft = "draft " if pr.get("isDraft") else ""
    print("- %s#%s %s [%s] %s %s" % (draft, n, (pr.get("title") or "")[:60], labels, pr.get("mergeable"), ci))
' || echo "- gh failed for $repo"
  done
  echo
  echo "### Failed default-branch workflows"
  for repo in $USINE_REPOS; do
    branch=$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || echo main)
    gh run list -R "$repo" --branch "$branch" --limit 10 --json databaseId,workflowName,conclusion,headSha \
      --jq '.[] | select(.conclusion=="failure") | "- \(.workflowName) at \(.headSha[:8]) (run \(.databaseId))"' 2>/dev/null
  done
fi

if [ -n "$USINE_SSH" ]; then
  echo
  echo "### Server errors, last 10 min"
  usine_host "journalctl -u usine.service --since '-10m' --no-pager -o cat 2>/dev/null | grep -E 'ERROR|FATAL|Salvage|restart_limit|parked' | cut -c1-200 | tail -20" || echo "- no journal access"
fi
