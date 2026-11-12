import { MemoryKilledProcess } from "@usine/core/attempt";
import type { ContainerId } from "@usine/core/worker";
import type { RemoteHost } from "@usine/agents/child-host";
import { Effect, Option, Schema } from "effect";
import type { RemoteCommands } from "./commands.ts";
import type { ContainerRuntime } from "./runtime.ts";

/**
 * A shell condition that holds if the user can read the host kernel's journal for the current boot.
 * An unreadable journal exits 0 with no entries, so the condition tests the output.
 */
const JOURNAL_READABLE = String.raw`[ -n "$(journalctl -k -b -n 1 --no-pager -o cat -q 2>/dev/null)" ]`;

/**
 * Prints `source journal` or `source dmesg`, then the host kernel's OOM diagnostics since the
 * creation of container `$2` from the journal, or every one in the ring buffer if the journal has
 * none. When the journal has none and the ring buffer is unreadable, prints `source journal` alone
 * if the journal is readable. Run it before the container's removal; fails if neither source is
 * readable.
 */
export const KERNEL_MEMORY_SCRIPT = String.raw`
set -eu
created=$("$1" container inspect --format '{{json .Created}}' "$2")
created=$(printf '%s' "$created" | cut -d '"' -f 2)
if logs=$(journalctl -k --since "$created" --no-pager -o cat -q --grep 'oom-kill:' 2>/dev/null) && [ -n "$logs" ]; then
  printf 'source journal\n%s\n' "$logs"
elif logs=$(dmesg --color=never); then
  echo 'source dmesg'
  printf '%s\n' "$logs" | grep -F 'oom-kill:' || true
elif ${JOURNAL_READABLE}; then
  echo 'source journal'
else
  exit 1
fi
`.trim();

/** A script that succeeds if the user can read the host kernel's journal or ring buffer. */
export const KERNEL_LOG_READABLE_SCRIPT = String.raw`
${JOURNAL_READABLE} || dmesg --color=never >/dev/null 2>&1
`.trim();

/** The kernel log that `KERNEL_MEMORY_SCRIPT` read, in its first line. */
const SOURCE_LINE = /^source (journal|dmesg)$/mu;

const decodeProcess = Schema.decodeUnknownOption(MemoryKilledProcess);

/** Matches the victim's cgroup, excluding kills in sibling attempt containers. */
export const killedProcessesFromKernel = (
  logs: string,
  container: ContainerId,
): ReadonlyArray<MemoryKilledProcess> =>
  logs.split("\n").flatMap((line) => {
    const match = /oom-kill:.*task_memcg=([^,]+),task=(.*),pid=(\d+),uid=\d+/u.exec(line);
    if (match === null) return [];
    const [, cgroup = "", command = "", pid = ""] = match;
    if (
      !cgroup
        .split("/")
        .some((part) =>
          [
            container,
            `docker-${container}.scope`,
            `libpod-${container}.scope`,
            `libpod-${container}`,
          ].includes(part),
        )
    )
      return [];
    return Option.toArray(decodeProcess({ command, pid: Number(pid) }));
  });

/**
 * Returns the processes that the kernel killed for memory in `container`, named `name`, from the
 * host's kernel logs, or `None` if they are unreadable.
 */
export const readKilledProcesses = Effect.fn("RemoteExecutor.readMemoryKilledProcesses")(
  function* (
    commands: RemoteCommands,
    shell: RemoteHost,
    runtime: ContainerRuntime,
    name: string,
    container: ContainerId,
  ) {
    const fields = { container, host: shell.destination };
    yield* Effect.annotateCurrentSpan(fields);
    const result = yield* commands.inspect("cleanup", shell, "sh", [
      "-c",
      KERNEL_MEMORY_SCRIPT,
      "sh",
      runtime,
      name,
    ]);
    if (result.exitCode !== 0) {
      yield* Effect.logWarning("Could not read kernel OOM process details on the worker", {
        ...fields,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
      return Option.none<ReadonlyArray<MemoryKilledProcess>>();
    }
    const processes = killedProcessesFromKernel(result.stdout, container);
    yield* Effect.logInfo("Read the kernel OOM process details on the worker", {
      ...fields,
      source: SOURCE_LINE.exec(result.stdout)?.[1] ?? "unknown",
      identified: processes.length,
    });
    return Option.some(processes);
  },
  (effect, _commands, shell, _runtime, _name, container) =>
    effect.pipe(
      Effect.catchTag("ExecutorOperationError", (error) =>
        Effect.logWarning("Could not collect kernel OOM process details", {
          container,
          host: shell.destination,
          message: error.message,
        }).pipe(Effect.as(Option.none<ReadonlyArray<MemoryKilledProcess>>())),
      ),
    ),
);

/**
 * Returns a preflight finding if the SSH user of `shell` can't read the host kernel's log, from
 * which out-of-memory kills get their process names, or `None` if it can.
 */
export const verifyKernelLog = Effect.fn("RemoteExecutor.verifyKernelLog")(
  function* (commands: RemoteCommands, shell: RemoteHost) {
    const host = shell.destination;
    yield* Effect.annotateCurrentSpan({ host });
    const result = yield* commands.inspect("preflight", shell, "sh", [
      "-c",
      KERNEL_LOG_READABLE_SCRIPT,
    ]);
    if (result.exitCode === 0) {
      yield* Effect.logDebug("The SSH user can read the kernel log", { host });
      return Option.none<string>();
    }
    yield* Effect.logWarning("The SSH user can't read the kernel log", {
      host,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    return Option.some(
      `The SSH user can't read the kernel journal or ring buffer on ${host}, so out-of-memory kills record no process names. Add the user to the systemd-journal group.`,
    );
  },
  (effect, _commands, shell) =>
    effect.pipe(
      Effect.catchTag("ExecutorOperationError", (error) =>
        Effect.logWarning("Could not check whether the SSH user can read the kernel log", {
          host: shell.destination,
          message: error.message,
        }).pipe(
          Effect.as(
            Option.some(
              `Could not check whether the SSH user can read the kernel log on ${shell.destination}: ${error.message}`,
            ),
          ),
        ),
      ),
    ),
);
