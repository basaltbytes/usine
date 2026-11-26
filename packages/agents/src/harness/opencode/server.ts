import {
  type Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  type Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { startChildProcess } from "../../child-host/node.ts";
import {
  ChildProcessLost,
  type ProcessTarget,
  processError,
  stopChildProcess,
} from "../../child-host/process.ts";
import { ChildSessionLifecycle, SessionOperationError } from "../../runtime.ts";
import { type BridgeClient, bridgeClient, bridgeCommand } from "./bridge/client.ts";

/** How long a new bridge has to report that OpenCode is ready. */
const READY_TIMEOUT = "60 seconds";
/** How long OpenCode has to exit after the bridge's input ends. */
const SHUTDOWN_TIMEOUT = "15 seconds";

/** Where and how to start an OpenCode bridge. */
export interface OpenCodeTarget extends ProcessTarget {
  /** `resume` adopts the bridge that the process owner retained; `replace` stops it first. */
  readonly transport?: "replace" | "resume" | undefined;
  /** The OpenCode command with any leading arguments; `opencode` by default. */
  readonly command?: { readonly command: string; readonly args: ReadonlyArray<string> };
}

/** A client of a running bridge. */
export interface OpenCodeConnection extends BridgeClient {
  /** Whether the process owner adopted a bridge that an earlier connection started. */
  readonly retained: boolean;
}

/** Starts and stops the OpenCode bridge of a session through `ChildHost`. */
export class OpenCodeServer extends Context.Service<
  OpenCodeServer,
  {
    /**
     * Starts the bridge around `opencode serve` on `target.host`, or adopts the retained one, and
     * waits for a new bridge's ready line. Closing the scope ends the bridge's input, waits for
     * OpenCode to exit, and stops the process if it doesn't.
     */
    readonly open: (
      target: OpenCodeTarget,
    ) => Effect.Effect<OpenCodeConnection, SessionOperationError, Scope.Scope>;
    /** Stops the bridge that the process owner retained for `target`'s session. */
    readonly stop: (target: ProcessTarget) => Effect.Effect<void, SessionOperationError>;
  }
>()("@usine/agents/harness/opencode/server/OpenCodeServer") {}

const makeOpenCodeServer = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const open = Effect.fn("OpenCodeServer.open")(function* (target: OpenCodeTarget) {
    const sessionId = Option.getOrUndefined(target.sessionId);
    yield* Effect.annotateCurrentSpan({ sessionId, host: target.host._tag });
    const lifecycle = yield* ChildSessionLifecycle.current;
    const input = yield* Queue.make<Uint8Array, Cause.Done>();
    const closing = yield* Ref.make(false);
    const handle = yield* startChildProcess(
      target,
      bridgeCommand({ command: "opencode", args: [], ...target.command, cwd: target.cwd }),
      Stream.fromQueue(input),
      { transport: target.transport },
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const generation = yield* handle.generation;
    // After the output ends, the bridge's exit tells a requested close from a lost process.
    const exited = Stream.unwrap(
      Effect.gen(function* () {
        const lost = yield* handle.exit;
        if (yield* Ref.get(closing)) return Stream.empty;
        return Stream.fail(
          processError(
            target,
            `The OpenCode bridge exited with code ${lost.exitCode}: ${lost.stderrTail.trim().slice(-2000) || "no diagnostics"}`,
            lost,
          ),
        );
      }),
    );
    // Completes once the client has read all of the bridge's output.
    const drained = yield* Deferred.make<void>();
    const client = yield* bridgeClient({
      sessionId: target.sessionId,
      input,
      output: Stream.concat(handle.stdout, exited).pipe(
        Stream.ensuring(Deferred.succeed(drained, undefined)),
      ),
      generation,
    });
    const close = Ref.set(closing, true).pipe(Effect.andThen(client.close));
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (yield* lifecycle.isStopping) return;
        yield* close;
        const exit = yield* Effect.all([handle.exit, Deferred.await(drained)]).pipe(
          Effect.map(([lost]) => lost),
          Effect.timeoutOption(SHUTDOWN_TIMEOUT),
          Effect.orElseSucceed(() => Option.none<ChildProcessLost>()),
        );
        if (Option.isSome(exit))
          return yield* Effect.logDebug("The OpenCode bridge exited", {
            sessionId,
            exitCode: exit.value.exitCode,
          });
        yield* Effect.logWarning("OpenCode didn't exit after its input ended; stopping it", {
          sessionId,
        });
        yield* handle.kill().pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Could not stop the OpenCode bridge", { sessionId, cause }),
          ),
          Effect.ignore,
        );
      }).pipe(Effect.withSpan("OpenCodeServer.close")),
    );
    const retained = Option.isSome(generation);
    if (retained)
      yield* Effect.logInfo("Adopted the OpenCode bridge that the process owner retained", {
        sessionId,
      });
    else
      yield* client.ready.pipe(
        Effect.timeoutOrElse({
          duration: READY_TIMEOUT,
          orElse: () =>
            Effect.fail(
              SessionOperationError.make({
                operation: "launch",
                sessionId: target.sessionId,
                message: `OpenCode wasn't ready within ${READY_TIMEOUT}`,
                cause: new Error("ready timed out"),
              }),
            ),
        }),
        Effect.tapError((error) =>
          Effect.logWarning("The OpenCode bridge didn't become ready", {
            sessionId,
            message: error.message,
          }),
        ),
      );
    return { ...client, close, retained } satisfies OpenCodeConnection;
  });

  const stop = Effect.fn("OpenCodeServer.stop")((target: ProcessTarget) =>
    stopChildProcess(target).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
  );
  return OpenCodeServer.of({ open, stop });
});

/** Provides `OpenCodeServer` over the process standard streams of `ChildProcessSpawner`. */
export const openCodeServerLive = Layer.effect(OpenCodeServer, makeOpenCodeServer);
