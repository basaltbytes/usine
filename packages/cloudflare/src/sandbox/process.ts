import { Option, Schema } from "effect";
import { ProcessId } from "../api/api.ts";
import { PROCESSES_DIRECTORY, SANDBOX_HOME } from "../api/harness.ts";

/**
 * Returns the Container API options of a command the Worker runs. The platform passes a command
 * only the image's `PATH`, not its `ENV HOME`, so the options set `HOME` and start the command in
 * the sandbox home.
 */
export const commandOptions = (stdin: "pipe" | "closed"): ContainerExecOptions => {
  const options: ContainerExecOptions = {
    cwd: SANDBOX_HOME,
    env: { HOME: SANDBOX_HOME },
    stdout: "pipe",
    stderr: "pipe",
  };
  return stdin === "pipe" ? { ...options, stdin: "pipe" } : options;
};

/** Returns the directory with the process files of `process`. */
const processDirectory = (process: ProcessId): string => `${PROCESSES_DIRECTORY}/${process}`;

/** The files a command leaves in its process directory. */
export const processFiles = (process: ProcessId) => {
  const directory = processDirectory(process);
  return {
    /** The command's process ID, which is also its process group and session. */
    pid: `${directory}/pid`,
    /** The exit code, written once the command exits. */
    exit: `${directory}/exit`,
    stdout: `${directory}/stdout`,
    stderr: `${directory}/stderr`,
  } as const;
};

/**
 * A POSIX shell script that runs the command line `$2` with process files in the directory `$1`,
 * and passes its stdin, stdout, stderr, and exit code through. Run it with `sh -c`.
 *
 * The command runs in its own session and writes its process ID to `pid`. The command and every
 * process that it starts get `USINE_PROCESS`, the directory, in their environment, so that
 * `STOP_SCRIPT` finds them even after the command exits or they leave its session. `tee -p` copies
 * its output to `stdout` and `stderr` and keeps copying if the stream that started it closes, so a
 * later request can attach. The exit code goes to `exit` when the command ends.
 */
export const PROCESS_SCRIPT = String.raw`
d=$1
mkdir -p "$d" && mkfifo "$d/stdout.pipe" "$d/stderr.pipe" || exit 125
exec 3<&0
tee -p -a "$d/stdout" < "$d/stdout.pipe" &
tee -p -a "$d/stderr" < "$d/stderr.pipe" >&2 &
USINE_PROCESS=$d setsid -w sh -c 'printf %s "$$" > "$0" && exec sh -c "$1"' "$d/pid" "$2" <&3 > "$d/stdout.pipe" 2> "$d/stderr.pipe" &
command=$!
exec 3<&-
wait "$command"
code=$?
wait
printf %s "$code" > "$d/exit.next" && mv "$d/exit.next" "$d/exit"
rm -f "$d/stdout.pipe" "$d/stderr.pipe"
exit "$code"
`.trim();

/** Returns the container command that runs `command` through `PROCESS_SCRIPT`. */
export const processCommand = (process: ProcessId, command: string): ReadonlyArray<string> => [
  "sh",
  "-c",
  PROCESS_SCRIPT,
  "usine-process",
  processDirectory(process),
  command,
];

/**
 * A bash script that stops what the commands in the processes directory `$1` started: every
 * process in the session of each command, and in the session of each process whose
 * `USINE_PROCESS` is in `$1`, so it includes what a command left running after it exited. It sends
 * TERM to each process group in those sessions, waits up to five seconds, then sends KILL until no
 * process is left. It prints the number of sessions it signaled, and fails if a process still runs
 * five seconds after the first KILL.
 *
 * A command that exited has released its process ID. If another process has that ID now, the
 * command's session has ended, and the script skips the session that has the ID now.
 */
export const STOP_SCRIPT = `
root=$1
declare -A groups=() sessions=()
read -r line < "/proc/$$/stat"
fields=(\${line##*") "})
own=\${fields[3]}
scan() {
  local process line fields entry
  groups=()
  for process in /proc/[0-9]*; do
    read -r line 2>/dev/null < "$process/stat" || continue
    fields=(\${line##*") "})
    case \${fields[0]} in Z|X) continue ;; esac
    groups[\${fields[3]}]+=" \${fields[2]}"
    [ "\${fields[3]}" = "$own" ] && continue
    while IFS= read -r -d '' entry; do
      case $entry in "USINE_PROCESS=$root"/*) sessions[\${fields[3]}]=1; break ;; esac
    done 2>/dev/null < "$process/environ"
  done
}
signal() {
  local session group
  local -A sent=()
  for session in "\${!sessions[@]}"; do
    for group in \${groups[$session]-}; do
      [ -n "\${sent[$group]-}" ] || kill "-$1" -- "-$group" 2>/dev/null
      sent[$group]=1
    done
  done
}
running() {
  local session
  for session in "\${!sessions[@]}"; do
    [ -n "\${groups[$session]-}" ] && echo "$session"
  done
}
scan
for pidfile in "$root"/*/pid; do
  [ -f "$pidfile" ] || continue
  read -r pid < "$pidfile"
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  [ -f "\${pidfile%/pid}/exit" ] && [ -e "/proc/$pid" ] && continue
  [ "$pid" != "$own" ] && [ -n "\${groups[$pid]-}" ] && sessions[$pid]=1
done
signal TERM
for _ in {1..20}; do
  [ -z "$(running)" ] && break
  sleep 0.25
  scan
done
for _ in {1..20}; do
  [ -z "$(running)" ] && break
  signal KILL
  sleep 0.25
  scan
done
left=$(running)
if [ -n "$left" ]; then
  echo "Processes still run after KILL in sessions" $left >&2
  exit 1
fi
echo "\${#sessions[@]}"
`.trim();

/** Returns the container command that runs `STOP_SCRIPT`. */
export const stopCommand: ReadonlyArray<string> = [
  "bash",
  "-c",
  STOP_SCRIPT,
  "usine-stop",
  PROCESSES_DIRECTORY,
];

/** Returns the container command that prints the bytes of `file` from `offset`. */
export const readFromCommand = (file: string, offset: number): ReadonlyArray<string> => [
  "tail",
  "-c",
  `+${String(offset + 1)}`,
  "--",
  file,
];

const decodeCount = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

/** Returns the number that `STOP_SCRIPT` printed, or `None` for any other output. */
export const stoppedCount = (output: string): Option.Option<number> => decodeCount(output.trim());

const decodePid = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
);

/** Returns the process ID in a `pid` file, or `None` if it's empty or malformed. */
export const pidOf = (content: string): Option.Option<number> => decodePid(content.trim());

const decodeExitCode = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 255 })),
);

/** Returns the exit code in an `exit` file, or `None` if it's malformed. */
export const exitCodeOf = (content: string): Option.Option<number> =>
  decodeExitCode(content.trim());

const ProcessIdBytes = 16;

/** Returns a new random process ID. */
export const newProcessId = (): ProcessId => {
  const bytes = crypto.getRandomValues(new Uint8Array(ProcessIdBytes));
  return ProcessId.make([...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
};
