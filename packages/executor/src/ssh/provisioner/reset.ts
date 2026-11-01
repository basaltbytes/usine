import type { RemoteShell } from "@usine/agents/child-host";
import type { InstanceId } from "@usine/core/instance";
import { Effect } from "effect";
import { ExecutorOperationError } from "../../executor.ts";
import type { RemoteCommands } from "../../remote/commands.ts";
import { containersFor } from "../../remote/container.ts";
import type { SshMachine } from "../model.ts";

/** Records cleanup errors before finalizers suppress them, and resets an unused machine. */
export const machineResetFor = (raw: RemoteCommands, instance: string, instanceId: InstanceId) => {
  const failures = new WeakSet<RemoteShell>();
  const failed = (shell: RemoteShell) => Effect.sync(() => void failures.add(shell));
  const commands: RemoteCommands = {
    ...raw,
    run: (operation, shell, command, args, context) =>
      raw
        .run(operation, shell, command, args, context)
        .pipe(Effect.tapError(() => (operation === "cleanup" ? failed(shell) : Effect.void))),
    runWithInput: (operation, shell, command, args, input) =>
      raw
        .runWithInput(operation, shell, command, args, input)
        .pipe(Effect.tapError(() => (operation === "cleanup" ? failed(shell) : Effect.void))),
  };
  const containers = containersFor(commands);
  const reset = Effect.fn("SshExecutor.resetMachine")(function* (machine: SshMachine) {
    const worker = machine.address.name;
    const host = machine.shell.destination;
    yield* Effect.annotateCurrentSpan({ worker, host });
    if (failures.has(machine.shell))
      return yield* new ExecutorOperationError({
        operation: "cleanup",
        message: "The previous attempt's cleanup failed; the machine must be retired",
        cause: new Error("incomplete attempt cleanup"),
      });
    const removed = yield* containers.sweep(machine.shell, instance, instanceId, worker, new Set());
    if (removed.length > 0)
      return yield* new ExecutorOperationError({
        operation: "cleanup",
        message: "The previous attempt left containers; the machine must be retired",
        cause: new Error("leftover attempt containers"),
      });
    yield* commands.run("cleanup", machine.shell, "rm", [
      "-rf",
      ...["attempts", "credentials", "codex", "gh", "container-checkouts"].map(
        (directory) => `${machine.workerDirectory}/${directory}`,
      ),
    ]);
    yield* Effect.logInfo("Reset the machine for reuse; shared caches and images remain", {
      worker,
      host,
    });
  });
  return { commands, failed, reset };
};
