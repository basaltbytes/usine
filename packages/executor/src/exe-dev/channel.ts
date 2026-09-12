import type * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { AttemptWorkspace, RunHostCommand } from "../executor.ts";
import { runHostSessionFor, type RunHostInput } from "../run-host-session.ts";
import type { ExeDevCommands } from "./commands.ts";
import type { VmState } from "./model.ts";
import { runHostShellCommand } from "./shell.ts";

export const attemptChannelFor = Effect.fn("ExeDevExecutor.attemptChannelFor")(function* (
  commands: ExeDevCommands,
  runHost: RunHostCommand,
  interruptGrace: Parameters<typeof Effect.timeoutOption>[1],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const spawn = Effect.fn("ExeDevExecutor.spawnRunHost")(function* (
    prepared: AttemptWorkspace,
    vm: VmState,
    input: RunHostInput,
  ) {
    const attemptId = prepared.spec.attemptId;
    yield* Effect.annotateCurrentSpan({
      attemptId,
      worker: prepared.worker,
      host: vm.sshDest,
    });
    yield* Effect.logInfo("Launching the run host over SSH", {
      attemptId,
      worker: prepared.worker,
      host: vm.sshDest,
      worktree: prepared.worktree,
    });
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        commands.ssh.command,
        [
          ...commands.ssh.args,
          vm.sshDest,
          "--",
          runHostShellCommand(prepared.worktree, runHost.command, runHost.args),
        ],
        {
          env: commands.environment,
          extendEnv: false,
          stdin: { stream: Stream.fromQueue(input), endOnDone: true },
        },
      ),
    );
    // Nothing to scrub: this process never has a secret the run host could echo,
    // because the exe.dev integration injects credentials on the VM. If a
    // credential ever passes through this process, scrub it here.
    return { handle, host: vm.sshDest, scrub: (text: string): string => text };
  });

  const session = yield* runHostSessionFor({ interruptGrace });
  return {
    cancel: session.cancel,
    intervene: session.intervene,
    launch: (prepared: AttemptWorkspace, vm: VmState, io: AttemptChannel.Sink) =>
      session.launch(prepared, io, (input) => spawn(prepared, vm, input)),
  };
});
