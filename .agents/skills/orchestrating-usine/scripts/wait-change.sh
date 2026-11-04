#!/usr/bin/env bash
# Polls the instance without printing anything and exits on the first change that needs a reaction.
# Run it with Bash run_in_background, read what it printed, then run it again.
# wait-change.sh [interval-seconds] [quiet-minutes]
. "$(dirname "$0")/lib.sh"
interval="${1:-180}"
quiet="${2:-30}"
state="$USINE_STATE/last-state.txt"
touch "$state"
failures=0

# Keeps only what needs a reaction: attention entries, stalled items, workers, failed workflows,
# server errors, pull requests ready to merge, and attempts with no activity
# for longer than quiet-minutes. Runs starting, ending, and label changes on the way are dropped.
normalize() {
  python3 -I -c '
import re, sys, datetime
quiet = int(sys.argv[1])
now = datetime.datetime.now(datetime.timezone.utc)
minutes = now.hour * 60 + now.minute
section = ""
for line in sys.stdin:
    line = line.rstrip("\n")
    if line.startswith("## ") or line.startswith("version:"):
        continue
    if line.startswith("- running ") and ", available " in line:
        line = re.sub(r", available \S+", "", line)
    match = re.search(r" since (\d\d:\d\d) last activity ?(\d\d:\d\d)?", line)
    if match:
        last = match.group(2) or match.group(1)
        age = (minutes - int(last[:2]) * 60 - int(last[3:])) % 1440
        line = re.sub(r" last activity.*$", "", line)
        if age >= quiet:
            line += " QUIET"
    line = re.sub(r"^(- \S+) \d+/\d+ ", r"\1 ", line)
    if line.startswith("### "):
        section = line
        continue
    if not line.strip():
        continue
    if section.startswith("### Running") and not line.endswith(" QUIET"):
        continue
    if section.startswith("### Upgrade") and line.rstrip().endswith("phase idle"):
        continue
    if section.startswith("### Open agent PRs") and not re.search(r"ready-to-merge", line):
        continue
    print(line)
' "$quiet"
}

while true; do
  raw=$("$(dirname "$0")/overview.sh" 2>/dev/null || true)
  if [ -z "$raw" ] || printf '%s' "$raw" | grep -q "overview unreachable"; then
    failures=$((failures + 1))
    if [ "$failures" -ge 4 ]; then
      echo "--- $(date -u +%H:%MZ) the instance has not answered for $failures polls"
      exit 0
    fi
    sleep "$interval"
    continue
  fi
  failures=0
  cur=$(printf '%s\n' "$raw" | normalize)
  if [ "$cur" != "$(cat "$state")" ]; then
    changes=$(diff <(cat "$state") <(printf '%s\n' "$cur") | grep -E '^[<>]' | sed -e 's/^< /gone: /' -e 's/^> /new: /' || true)
    printf '%s\n' "$cur" > "$state"
    # Something that went away needs no reaction, such as a log line older than the error window.
    if printf '%s\n' "$changes" | grep -q '^new: '; then
      echo "--- $(date -u +%H:%MZ)"
      printf '%s\n' "$changes"
      exit 0
    fi
  fi
  sleep "$interval"
done
