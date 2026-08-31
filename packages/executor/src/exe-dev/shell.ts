const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** One shell-safe command string for OpenSSH's remote-command boundary. */
export const shellCommand = (command: string, args: ReadonlyArray<string>): string =>
  `exec ${[command, ...args].map(quote).join(" ")}`;

/** The run host needs a working directory and one public edge-host selector. */
export const runHostShellCommand = (
  worktree: string,
  command: string,
  args: ReadonlyArray<string>,
): string =>
  `cd ${quote(worktree)} && export GH_HOST=github.int.exe.xyz && ${shellCommand(command, args)}`;
