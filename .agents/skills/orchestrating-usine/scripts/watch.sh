#!/usr/bin/env bash
# Change-only monitor for the Monitor tool. Prints a line only when something differs from the last pass.
# watch.sh [interval-seconds]
. "$(dirname "$0")/lib.sh"
interval="${1:-60}"
prev=""
while true; do
  cur=$("$(dirname "$0")/overview.sh" 2>/dev/null | grep -v '^## ' || true)
  if [ "$cur" != "$prev" ]; then
    echo "--- $(date -u +%H:%MZ)"
    if [ -n "$prev" ]; then
      comm -13 <(printf '%s\n' "$prev" | sort) <(printf '%s\n' "$cur" | sort)
    else
      printf '%s\n' "$cur"
    fi
  fi
  prev="$cur"
  sleep "$interval"
done
