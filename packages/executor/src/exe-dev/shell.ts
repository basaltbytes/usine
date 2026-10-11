/**
 * Stops every child an Attempt still runs on the VM before its worktree is
 * kept or removed: for each `<worktree>.child-*.pid` (see `childPidFile` in
 * `@usine/agents/child-host`), TERM, a bounded wait, then KILL. `$1` is the
 * worktree; stdout reports one outcome per pid file. An SSH client that exits
 * does not prove its remote command has stopped.
 */
export const CHILD_KILL_SCRIPT = `
found=0
for pidfile in "$1".child-*.pid; do
  test -f "$pidfile" || continue
  found=1
  pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; then
    n=0
    while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 10 ]; do sleep 0.5; n=$((n+1)); done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null; echo "$pidfile killed"; else echo "$pidfile stopped"; fi
  else
    echo "$pidfile absent"
  fi
  rm -f "$pidfile"
done
test "$found" = 1 || echo no-children
`.trim();
