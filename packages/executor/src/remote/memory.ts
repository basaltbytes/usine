import { MemoryKilledProcess } from "@usine/core/attempt";
import type { ContainerId } from "@usine/core/worker";
import type { RemoteHost } from "@usine/agents/child-host";
import { Effect, Option, Schema } from "effect";
import type { RemoteCommands } from "./commands.ts";
import type { ContainerRuntime } from "./runtime.ts";

/**
 * Prints `source journal` or `source dmesg`, then the host kernel's OOM diagnostics since the
 * creation of container `$2` from the journal, or every one in the ring buffer if the journal has
 * none. Run it before the container's removal; fails if neither source is readable.
 */
export const KERNEL_MEMORY_SCRIPT = String.raw`
set -eu
created=$("$1" container inspect --format '{{json .Created}}' "$2")
created=$(printf '%s' "$created" | cut -d '"' -f 2)
if logs=$(journalctl -k --since "$created" --no-pager -o cat --grep 'oom-kill:' 2>/dev/null) && [ -n "$logs" ]; then
  printf 'source journal\n%s\n' "$logs"
else
  logs=$(dmesg --color=never)
  echo 'source dmesg'
  printf '%s\n' "$logs" | grep -F 'oom-kill:' || true
fi
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
 * host's kernel logs; empty if they are unreadable.
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
      return [];
    }
    const processes = killedProcessesFromKernel(result.stdout, container);
    yield* Effect.logInfo("Read the kernel OOM process details on the worker", {
      ...fields,
      source: SOURCE_LINE.exec(result.stdout)?.[1] ?? "unknown",
      identified: processes.length,
    });
    return processes;
  },
  (effect, _commands, shell, _runtime, _name, container) =>
    effect.pipe(
      Effect.catchTag("ExecutorOperationError", (error) =>
        Effect.logWarning("Could not collect kernel OOM process details", {
          container,
          host: shell.destination,
          message: error.message,
        }).pipe(Effect.as([])),
      ),
    ),
);
