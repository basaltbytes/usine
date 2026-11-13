import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import { WorkerName } from "@usine/core/worker";
import {
  Cause,
  Deferred,
  Effect,
  Layer,
  Option,
  PlatformError,
  Predicate,
  Queue,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { LocalProcess } from "../../../src/child-host/child-host.ts";
import { ChildRequest, WorkingDirectory } from "../../../src/runtime.ts";

export const request = ChildRequest.make({
  worker: WorkerName.make("worker-1"),
  machine: Option.none(),
  environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
  host: LocalProcess.make(),
  session: ChildSession.make({
    id: AgentSessionId.make("parent:attempt-1:child:2"),
    parentId: AgentSessionId.make("parent:attempt-1"),
    agent: AgentName.make("developer"),
    brain: BrainSpec.make({
      harness: Harness.make("codex"),
      model: ModelId.make("gpt-5.6-terra"),
      effort: "medium",
    }),
  }),
  cwd: WorkingDirectory.make("/workspace/repo"),
  prompt: "Implement the focused task.",
});

interface FakeProcess {
  readonly stdout: Queue.Queue<Uint8Array, Cause.Done>;
  readonly stderr: Queue.Queue<Uint8Array, Cause.Done>;
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  readonly stdinClosed: Deferred.Deferred<void>;
  readonly killed: Deferred.Deferred<void>;
  readonly stdinLines: Array<string>;
}

export const fakeProcess = Effect.gen(function* () {
  return {
    stdout: yield* Queue.make<Uint8Array, Cause.Done>(),
    stderr: yield* Queue.make<Uint8Array, Cause.Done>(),
    exit: yield* Deferred.make<ChildProcessSpawner.ExitCode>(),
    stdinClosed: yield* Deferred.make<void>(),
    killed: yield* Deferred.make<void>(),
    stdinLines: [],
  } satisfies FakeProcess;
});

export const spawnerFor = (
  process: FakeProcess,
  options: {
    readonly exitOnEof?: boolean;
    readonly stdout?: Stream.Stream<Uint8Array>;
    readonly kill?: Effect.Effect<void, PlatformError.PlatformError>;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  } = {},
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        yield* Deferred.await(process.exit).pipe(
          Effect.andThen(Queue.end(process.stdout)),
          Effect.andThen(Queue.end(process.stderr)),
          Effect.forkScoped,
        );
        if (
          command._tag === "StandardCommand" &&
          Predicate.hasProperty(command.options.stdin, "stream") &&
          Stream.isStream(command.options.stdin.stream)
        ) {
          yield* command.options.stdin.stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((written) =>
              Effect.sync(() => {
                process.stdinLines.push(written);
              }),
            ),
            Effect.andThen(Deferred.succeed(process.stdinClosed, undefined)),
            Effect.andThen(
              options.exitOnEof === false
                ? Effect.void
                : Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0)),
            ),
            Effect.forkScoped,
          );
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: options.exitCode ?? Deferred.await(process.exit),
          isRunning: Deferred.isDone(process.exit).pipe(Effect.map((exited) => !exited)),
          kill: () =>
            Deferred.succeed(process.killed, undefined).pipe(
              Effect.andThen(
                options.kill ??
                  Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(137)).pipe(
                    Effect.asVoid,
                  ),
              ),
            ),
          stdin: Sink.drain,
          stdout: options.stdout ?? Stream.fromQueue(process.stdout),
          stderr: Stream.fromQueue(process.stderr),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
