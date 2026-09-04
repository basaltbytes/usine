const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Quotes a command and its arguments into one string safe for OpenSSH's remote-command boundary. */
export const shellCommand = (command: string, args: ReadonlyArray<string>): string =>
  `exec ${[command, ...args].map(quote).join(" ")}`;

/** The pid file sits beside the worktree so the sweep reclaims both together. */
export const runHostPidFile = (worktree: string): string => `${worktree}.pid`;

/** The remote command that starts the run host in its worktree with the edge GitHub host selected. */
export const runHostShellCommand = (
  worktree: string,
  command: string,
  args: ReadonlyArray<string>,
): string =>
  // `$$` names the remote shell that `exec` replaces with the run host, so the
  // pid file identifies the run host itself. Cleanup uses it to confirm the
  // process is gone before removing the worktree.
  `cd ${quote(worktree)} && export GH_HOST=github.int.exe.xyz && printf '%s' "$$" > ${quote(runHostPidFile(worktree))} && ${shellCommand(command, args)}`;

/**
 * Confirms a recorded run host is dead before workspace removal: TERM, a
 * bounded wait, then KILL. `$1` is the pid file; stdout reports the outcome.
 */
export const RUN_HOST_KILL_SCRIPT = `
if test -f "$1"; then
  pid=$(cat "$1")
  if kill -TERM "$pid" 2>/dev/null; then
    n=0
    while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 10 ]; do sleep 0.5; n=$((n+1)); done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null; echo killed; else echo stopped; fi
  else
    echo absent
  fi
  rm -f "$1"
else
  echo no-pidfile
fi
`.trim();
