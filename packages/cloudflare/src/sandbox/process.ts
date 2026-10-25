import { Option, Schema } from "effect";
import { ProcessId } from "../api/api.ts";
import { PROCESSES_DIRECTORY } from "../api/harness.ts";

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
 * The command runs in its own session, so stopping its process group stops what it started, and
 * writes its process ID to `pid`. `tee -p` copies its output to `stdout` and `stderr` and keeps
 * copying if the stream that started it closes, so a later request can attach. The exit code goes
 * to `exit` when the command ends.
 */
export const PROCESS_SCRIPT = String.raw`
d=$1
mkdir -p "$d" && mkfifo "$d/stdout.pipe" "$d/stderr.pipe" || exit 125
exec 3<&0
tee -p -a "$d/stdout" < "$d/stdout.pipe" &
tee -p -a "$d/stderr" < "$d/stderr.pipe" >&2 &
setsid -w sh -c 'printf %s "$$" > "$0" && exec sh -c "$1"' "$d/pid" "$2" <&3 > "$d/stdout.pipe" 2> "$d/stderr.pipe" &
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
 * A bash script that stops every command that still runs in the processes directory `$1`: it
 * sends TERM to each process group, waits up to five seconds, then sends KILL. It prints the
 * number of commands it signaled.
 */
export const STOP_SCRIPT = String.raw`
root=$1
set --
for pidfile in "$root"/*/pid; do
  [ -f "$pidfile" ] || continue
  [ -f "$(dirname "$pidfile")/exit" ] && continue
  pid=$(cat "$pidfile")
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  kill -TERM -- "-$pid" 2>/dev/null && set -- "$@" "$pid"
done
for pid in "$@"; do
  n=0
  while kill -0 -- "-$pid" 2>/dev/null && [ "$n" -lt 20 ]; do sleep 0.25; n=$((n+1)); done
  kill -KILL -- "-$pid" 2>/dev/null
done
echo "$#"
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
