// SDK process callbacks require synchronous stream handles.
import { EventEmitter } from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { PassThrough } from "node:stream";
import { type Cause, Deferred, Effect, Option, Queue, Ref, Scope, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { type ProcessOptions, type ProcessTarget, processError } from "./process.ts";
import { startChildProcess } from "./node.ts";
import { ChildSessionLifecycle, SessionOperationError } from "../runtime.ts";

interface SpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

class SdkProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  readonly stop: () => void;
  constructor(stop: () => void) {
    super();
    this.stop = stop;
  }
  kill(_signal: NodeJS.Signals) {
    this.killed = true;
    this.stop();
    return true;
  }
}

/** How the SDK's child process starts and checkpoints its output. */
export interface SdkProcessOptions extends Pick<
  ProcessOptions,
  "transport" | "onInputAcknowledged"
> {
  /** Reads a chunk of the child's output; returns the bytes that became checkpointed. */
  readonly readOutput?: (bytes: Uint8Array) => Effect.Effect<number>;
}

/** Adapts SDK stream handles to the scoped process owner, which checkpoints handled output. */
export const sdkProcessSpawner = Effect.fn("ChildHost.sdkProcessSpawner")(function* (
  target: ProcessTarget,
  { readOutput = () => Effect.succeed(0), ...processOptions }: SdkProcessOptions = {},
) {
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const lifecycle = yield* ChildSessionLifecycle.current;
  const scope = yield* Effect.scope;
  const failure = yield* Ref.make(Option.none<SessionOperationError>());
  const retained = yield* Ref.make(false);
  // The started process's output acknowledgement, or `None` when it failed to start.
  const acknowledgeOutput =
    yield* Deferred.make<Option.Option<(bytes: number) => Effect.Effect<void>>>();
  const run = Effect.runForkWith(context);
  const spawn = (options: SpawnOptions) => {
    const process = new SdkProcess(() => {
      run(stop);
    });
    let stop = Effect.void;
    const runProcess = Effect.gen(function* () {
      const input = yield* Queue.make<Uint8Array, Cause.Done>();
      process.stdin.on("data", (data: Uint8Array) => Queue.offerUnsafe(input, data));
      process.stdin.on("end", () => Queue.endUnsafe(input));
      const handle = yield* startChildProcess(
        {
          ...target,
          environment: Object.fromEntries(
            Object.entries(options.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        },
        { command: options.command, args: options.args, cwd: options.cwd ?? target.cwd },
        Stream.fromQueue(input),
        { ...processOptions, acknowledgement: "handled" },
      );
      yield* Deferred.succeed(acknowledgeOutput, Option.some(handle.acknowledgeOutput));
      const generation = yield* handle.generation;
      yield* Ref.set(retained, Option.isSome(generation));
      stop = Effect.gen(function* () {
        if (yield* lifecycle.isStopping) return;
        yield* handle.kill();
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not stop SDK child process", {
            sessionId: Option.getOrUndefined(target.sessionId),
            cause,
          }),
        ),
      );
      if (process.killed || options.signal.aborted) yield* stop;
      const [event] = yield* Effect.all(
        [
          handle.exit,
          handle.stdout.pipe(
            Stream.runForEach((data) =>
              readOutput(data).pipe(
                Effect.flatMap(handle.acknowledgeOutput),
                Effect.andThen(
                  Effect.sync(() => {
                    process.stdout.write(data);
                  }),
                ),
              ),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const error = processError(target, `Child process exited with code ${event.exitCode}`, event);
      yield* Ref.set(failure, Option.some(error));
      process.exitCode = event.exitCode;
      process.stdout.end();
      process.emit("exit", event.exitCode, null);
    }).pipe(
      Effect.ensuring(Deferred.succeed(acknowledgeOutput, Option.none())),
      Scope.provide(scope),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Ref.set(failure, Option.some(error));
          process.stdout.destroy(new Error(error.message));
          process.emit("error", new Error(error.message));
        }),
      ),
    );
    options.signal.addEventListener("abort", process.stop, { once: true });
    run(
      Effect.forkIn(
        runProcess.pipe(Effect.provideService(ChildSessionLifecycle, lifecycle)),
        scope,
      ),
    );
    return process;
  };
  return {
    spawn,
    retained: Ref.get(retained),
    /**
     * Checkpoints `bytes` of handled output. Output exists only once the process started, so a
     * positive count waits for its start; the count is ignored if the process failed to start.
     */
    acknowledge: (bytes: number) =>
      bytes === 0
        ? Effect.void
        : Deferred.await(acknowledgeOutput).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (acknowledge) => acknowledge(bytes),
              }),
            ),
          ),
    diagnose: (error: SessionOperationError) =>
      Ref.get(failure).pipe(Effect.map(Option.getOrElse(() => error))),
  };
});
