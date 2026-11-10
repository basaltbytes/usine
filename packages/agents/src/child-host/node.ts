import { CHILD_LIFELINE } from "./lifeline.ts";
export { CHILD_LIFELINE } from "./lifeline.ts";
import { Deferred, Effect, Fiber, Option, Ref, Schema, Stream } from "effect";
import type { ChildProcess } from "effect/process";
import { childPidFile, isRemoteHost } from "./child-host.ts";
import { hostCommand, hostSpawn } from "./command.ts";
import { SessionOperationError } from "../runtime.ts";
import {
  ChildProcessLost,
  type ProcessCommand,
  type ProcessTarget,
  processError,
  remoteProcess,
} from "./process.ts";

/** Returns the invocation and options that start `command` for `target` without a process owner. */
const childInvocation = (
  target: ProcessTarget,
  command: ProcessCommand,
  stdin?: ChildProcess.CommandOptions["stdin"],
) => {
  let invocation = { ...command, environment: target.environment };
  let options: ChildProcess.CommandOptions = { detached: false, forceKillAfter: "6 seconds" };
  if (stdin !== undefined) options = { ...options, stdin };
  if (target.host._tag === "LocalProcess") {
    invocation = {
      ...invocation,
      command: process.execPath,
      args: [
        "-e",
        CHILD_LIFELINE,
        Option.match(target.sessionId, {
          onNone: () => "",
          onSome: (id) => childPidFile(target.cwd, id),
        }),
        "",
        command.command,
        ...command.args,
      ],
    };
    options = { ...options, additionalFds: { fd3: { type: "input" } } };
  }
  return { invocation, options };
};

/**
 * Returns the command that starts `command` for `target` without a process owner. Throws if
 * `target` is a remote host and its environment is not empty, or if it is an `ExecShell`, which
 * runs commands in this process.
 */
export const childProcessCommand = (
  target: ProcessTarget,
  command: ProcessCommand,
  stdin?: ChildProcess.CommandOptions["stdin"],
) => {
  const { invocation, options } = childInvocation(target, command, stdin);
  return hostCommand(target.host, invocation, options);
};

/** Opens a child with shared diagnostics, process-group cleanup, and transport recovery. */
export const startChildProcess = Effect.fn("ChildHost.startChildProcess")(function* (
  target: ProcessTarget,
  command: ProcessCommand,
  input: Stream.Stream<Uint8Array>,
  transport?: "replace" | "resume",
  acknowledgement: "received" | "handled" = "received",
  onInputAcknowledged?: (bytes: Uint8Array) => Effect.Effect<number>,
) {
  yield* Effect.annotateCurrentSpan({ sessionId: Option.getOrUndefined(target.sessionId) });
  if (isRemoteHost(target.host) && Option.isSome(target.sessionId))
    return yield* remoteProcess(
      { ...target, sessionId: target.sessionId },
      command,
      input,
      transport,
      acknowledgement,
      onInputAcknowledged,
    );
  const { invocation, options } = childInvocation(target, command, {
    stream: input.pipe(Stream.tap((data) => onInputAcknowledged?.(data) ?? Effect.void)),
    endOnDone: true,
  });
  const handle = yield* hostSpawn(target.host, invocation, options).pipe(
    Effect.mapError((cause) => processError(target, "Child process failed to start", cause)),
  );
  const stderr = yield* Ref.make("");
  const diagnostics = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => Ref.update(stderr, (tail) => (tail + text).slice(-8192))),
    Effect.mapError((cause) => processError(target, "Could not read child diagnostics", cause)),
    Effect.forkScoped,
  );
  const exit = yield* Deferred.make<ChildProcessLost, SessionOperationError>();
  yield* handle.exitCode.pipe(
    Effect.flatMap((exitCode) =>
      Fiber.join(diagnostics).pipe(
        Effect.andThen(Ref.get(stderr)),
        Effect.map((stderrTail) => ChildProcessLost.make({ exitCode, stderrTail })),
      ),
    ),
    Effect.mapError((cause) =>
      Schema.is(SessionOperationError)(cause)
        ? cause
        : processError(target, "Could not monitor the child process", cause),
    ),
    Deferred.into(exit),
    Effect.forkScoped,
  );
  return {
    stdout: handle.stdout.pipe(
      Stream.mapError((cause) => processError(target, "Could not read child output", cause)),
    ),
    exit: Deferred.await(exit),
    generation: Effect.succeed(Option.none<number>()),
    acknowledgeOutput: (_bytes: number) => Effect.void,
    kill: () =>
      handle
        .kill({ forceKillAfter: "6 seconds" })
        .pipe(
          Effect.mapError((cause) =>
            processError(target, "Could not stop the child process", cause),
          ),
        ),
  };
});
