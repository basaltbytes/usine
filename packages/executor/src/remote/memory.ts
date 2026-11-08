import { MemoryKilledProcess } from "@usine/core/attempt";
import type { ContainerId } from "@usine/core/worker";
import type { RemoteShell } from "@usine/agents/child-host";
import { Effect, Option, Schema } from "effect";
import type { RemoteCommands } from "./commands.ts";
import type { ContainerRuntime } from "./runtime.ts";

/** Reads host kernel OOM diagnostics since container creation, before removal. */
export const KERNEL_MEMORY_SCRIPT = String.raw`
set -eu
created=$("$1" container inspect --format '{{json .Created}}' "$2")
created=$(printf '%s' "$created" | cut -d '"' -f 2)
if logs=$(journalctl -k --since "$created" --no-pager -o cat --grep 'oom-kill:' 2>/dev/null) && [ -n "$logs" ]; then
  printf '%s\n' "$logs"
else
  dmesg --color=never
fi
`.trim();

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
          [container, `docker-${container}.scope`, `libpod-${container}.scope`].includes(part),
        )
    )
      return [];
    return Option.toArray(decodeProcess({ command, pid: Number(pid) }));
  });

export const readKilledProcesses = Effect.fn("RemoteExecutor.readMemoryKilledProcesses")(
  function* (
    commands: RemoteCommands,
    shell: RemoteShell,
    runtime: ContainerRuntime,
    name: string,
    container: ContainerId,
  ) {
    yield* Effect.annotateCurrentSpan({ container, host: shell.destination });
    const result = yield* commands.inspect("cleanup", shell, "sh", [
      "-c",
      KERNEL_MEMORY_SCRIPT,
      "sh",
      runtime,
      name,
    ]);
    if (result.exitCode !== 0) {
      yield* Effect.logWarning("Could not read kernel OOM process details on the worker", {
        container,
        host: shell.destination,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
      return [];
    }
    return killedProcessesFromKernel(result.stdout, container);
  },
  Effect.catchTag("ExecutorOperationError", (error) =>
    Effect.logWarning("Could not collect kernel OOM process details", {
      message: error.message,
    }).pipe(Effect.as([])),
  ),
);
