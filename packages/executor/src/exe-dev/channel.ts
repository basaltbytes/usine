import { AttemptFailure } from "@usine/core";
import { Effect, Ref, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PreparedAttempt, RunHostCommand } from "../index.ts";
import { runHostSessionFor, type RunHostInput, type RunHostSession } from "../run-host-session.ts";
import type { ExeDevCommands } from "./commands.ts";
import type { PreparedStates } from "./model.ts";
import { runHostShellCommand } from "./shell.ts";

export const attemptChannelFor: (
  commands: ExeDevCommands,
  preparedStates: PreparedStates,
  runHost: RunHostCommand,
  interruptGrace: Parameters<typeof Effect.timeoutOption>[1],
) => Effect.Effect<RunHostSession, never, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn(
  "ExeDevExecutor.attemptChannelFor",
)(function* (
  commands: ExeDevCommands,
  preparedStates: PreparedStates,
  runHost: RunHostCommand,
  interruptGrace: Parameters<typeof Effect.timeoutOption>[1],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const spawn = Effect.fn("ExeDevExecutor.spawnRunHost")(function* (
    prepared: PreparedAttempt,
    input: RunHostInput,
  ) {
    const attemptId = prepared.spec.attemptId;
    const state = (yield* Ref.get(preparedStates)).get(attemptId);
    if (state === undefined) {
      return yield* new AttemptFailure.InfraFailure({
        message: `Attempt ${attemptId} has no prepared exe.dev workspace`,
        cause: new Error("prepared Attempt state missing"),
      });
    }
    yield* Effect.annotateCurrentSpan({
      attemptId,
      worker: prepared.worker,
      host: state.vm.sshDest,
    });
    yield* Effect.logInfo("Launching the run host over SSH", {
      attemptId,
      worker: prepared.worker,
      host: state.vm.sshDest,
      worktree: prepared.worktree,
    });
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        commands.ssh.command,
        [
          ...commands.ssh.args,
          state.vm.sshDest,
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
    return { handle, host: state.vm.sshDest, scrubStderr: (text: string): string => text };
  });

  return yield* runHostSessionFor({ interruptGrace, spawn });
});
