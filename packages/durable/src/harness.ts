import type { Context as ChordContext } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type CommitPublication,
  createRegistry,
  type Extension,
  Harness,
  type ModelRef,
  type Storage,
  StorageRejected,
} from "@earendil-works/pi-durable";
import { Context, Deferred, Effect, Layer, Option, Result, Schedule, Schema, Scope } from "effect";

/** A pi-durable call failed: the harness could not open, commit, read, or wait. */
export class DurableHarnessError extends Schema.TaggedError<DurableHarnessError>(
  "@usine/durable/DurableHarnessError",
)("DurableHarnessError", {
  operation: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/** Observes the open harness, across reopens. */
export interface HarnessListener {
  /** Runs synchronously after every adopted commit; it must not block, throw, or call the harness. */
  readonly onCommit: (publication: CommitPublication) => void;
  /** Runs once a poisoned Session has been replaced by a freshly opened and resumed harness. */
  readonly onReopen: () => void;
}

/** What the harness runs on. */
export interface DurableHarnessOptions {
  /** Opens the storage; run again to reopen after a poisoned Session. */
  readonly openStorage: Effect.Effect<Storage, DurableHarnessError>;
  /** pi-ai model access for generation and parent model resolution. */
  readonly models: Models;
  /** The parent model when an Attempt names none; absent means the first model with a configured credential. */
  readonly defaultModel: Option.Option<ModelRef>;
}

/**
 * The orchestrator's pi-durable Harness over one storage. A commit that fails
 * after storage admission poisons the whole Session; the harness detects it,
 * closes the Session, opens the storage again, and resumes its tasks.
 */
export class DurableHarness extends Context.Service<
  DurableHarness,
  {
    readonly models: Models;
    readonly defaultModel: Option.Option<ModelRef>;
    /** Installs or replaces an extension; conversations that select it by name use the new code from their next phase. */
    readonly install: (extension: Extension) => Effect.Effect<void>;
    /**
     * Starts the task scheduler, also after every reopen. Call it once every
     * extension is installed: a generation resumed earlier would be prepared
     * without the tools its conversation selects.
     */
    readonly resume: Effect.Effect<void, DurableHarnessError>;
    /**
     * Runs one call against the open harness. A call that fails because the
     * Session was poisoned or replaced runs once more on the reopened harness,
     * so it must be safe to repeat.
     */
    readonly use: <A>(
      operation: string,
      run: (harness: Harness, context: ChordContext) => Promise<A>,
    ) => Effect.Effect<A, DurableHarnessError>;
    /** Observes commits and reopens while the scope is open. */
    readonly subscribe: (listener: HarnessListener) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@usine/durable/DurableHarness") {}

const POISONED_MESSAGE = "Session is poisoned";

/** pi-durable reports a poisoned Session only through this message. */
const isPoisoned = (cause: unknown): boolean =>
  cause instanceof Error && cause.message.startsWith(POISONED_MESSAGE);

const messageOf = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause) || "unknown";

/** Wraps a failed pi-durable call, naming what it was doing. */
export const durableError = (operation: string, cause: unknown) =>
  new DurableHarnessError({ operation, message: messageOf(cause), cause });

/** Reports every storage commit failure that poisons the Session; pi-durable treats all but `StorageRejected` that way. */
const watchCommits = (storage: Storage, onPoison: (cause: unknown) => void): Storage => {
  const commit: Storage["commit"] = (writes, context) =>
    storage.commit(writes, context).catch((cause: unknown) => {
      if (!(cause instanceof StorageRejected)) onPoison(cause);
      throw cause;
    });
  return new Proxy(storage, {
    get: (target, property) => {
      if (property === "commit") return commit;
      // SAFETY: the proxy only forwards Storage members; storage classes keep private state, so methods stay bound to the target.
      const member = target[property as keyof Storage];
      return member instanceof Function ? member.bind(target) : member;
    },
  });
};

interface Opened {
  readonly generation: number;
  readonly harness: Harness;
}

const make = Effect.fn("DurableHarness.make")(function* (options: DurableHarnessOptions) {
  const services = yield* Effect.context<never>();
  const fork = Effect.runForkWith(services);
  const scope = yield* Effect.scope;
  const registry = createRegistry();
  const listeners = new Set<HarnessListener>();
  let resumed = false;
  let closed = false;
  let reopening = Option.none<Deferred.Deferred<Opened>>();

  const open = Effect.fn("DurableHarness.open")(function* (generation: number) {
    yield* Effect.annotateCurrentSpan({ generation });
    const storage = yield* options.openStorage;
    const harness = yield* Effect.tryPromise({
      try: () =>
        Harness.open(
          watchCommits(storage, (cause) => requestReopen(generation, cause)),
          {
            models: options.models,
            registry,
            onReport: (error) => {
              fork(
                Effect.logWarning("pi-durable reported a failure that did not fail its caller", {
                  generation,
                  cause: messageOf(error),
                }),
              );
              if (isPoisoned(error)) requestReopen(generation, error);
            },
          },
          BACKGROUND_CONTEXT,
        ),
      catch: (cause) => durableError("open", cause),
    });
    harness.subscribeCommits((publication) => {
      for (const listener of listeners) listener.onCommit(publication);
    });
    if (resumed) harness.resume();
    yield* Effect.logInfo("Opened the durable harness", { generation, resumed });
    return { generation, harness } satisfies Opened;
  });

  const close = Effect.fn("DurableHarness.close")(function* (opened: Opened) {
    yield* Effect.annotateCurrentSpan({ generation: opened.generation });
    yield* Effect.tryPromise({
      try: () => opened.harness.close(BACKGROUND_CONTEXT),
      catch: (cause) => durableError("close", cause),
    }).pipe(
      Effect.tapError((error) =>
        Effect.logError("Could not close the durable harness", {
          generation: opened.generation,
          message: error.message,
        }),
      ),
      Effect.ignore,
    );
  });

  let current = yield* open(1);

  const reopen = Effect.fn("DurableHarness.reopen")(function* (
    previous: Opened,
    cause: unknown,
    ready: Deferred.Deferred<Opened>,
  ) {
    yield* Effect.annotateCurrentSpan({ generation: previous.generation });
    yield* Effect.logError(
      "A durable commit failed after storage admission and poisoned the Session; reopening the harness",
      { generation: previous.generation, cause: messageOf(cause) },
    );
    yield* close(previous);
    const next = yield* open(previous.generation + 1).pipe(
      Effect.tapError((error) =>
        Effect.logError("Could not reopen the durable harness; retrying", {
          generation: previous.generation + 1,
          message: error.message,
        }),
      ),
      Effect.retry(Schedule.spaced("1 second")),
      Effect.orDie,
    );
    current = next;
    reopening = Option.none();
    yield* Deferred.succeed(ready, next);
    for (const listener of listeners) listener.onReopen();
    yield* Effect.logInfo("Reopened the durable harness after a poisoned Session", {
      generation: next.generation,
    });
  });

  // Called synchronously from inside pi-durable; the reopen runs on its own fiber.
  function requestReopen(generation: number, cause: unknown) {
    if (closed || Option.isSome(reopening) || current.generation !== generation) return;
    const ready = Deferred.makeUnsafe<Opened>();
    reopening = Option.some(ready);
    fork(reopen(current, cause, ready).pipe(Effect.forkIn(scope)));
  }

  const opened: Effect.Effect<Opened> = Effect.suspend(() =>
    Option.match(reopening, {
      onNone: () => Effect.succeed(current),
      onSome: Deferred.await,
    }),
  );

  const use = <A>(
    operation: string,
    run: (harness: Harness, context: ChordContext) => Promise<A>,
  ): Effect.Effect<A, DurableHarnessError> =>
    Effect.gen(function* () {
      for (let attempt = 1; ; attempt += 1) {
        const target = yield* opened;
        const outcome = yield* Effect.tryPromise({
          try: (signal) => run(target.harness, withAbortSignal(signal, BACKGROUND_CONTEXT)),
          catch: (cause) => cause,
        }).pipe(Effect.result);
        if (Result.isSuccess(outcome)) return outcome.success;
        const cause = outcome.failure;
        if (isPoisoned(cause)) requestReopen(target.generation, cause);
        const replaced = Option.isSome(reopening) || current.generation !== target.generation;
        if (attempt === 1 && replaced) {
          yield* Effect.logInfo("Repeating a durable call on the reopened harness", {
            operation,
            generation: target.generation,
          });
          continue;
        }
        return yield* durableError(operation, cause);
      }
    }).pipe(Effect.withSpan(`DurableHarness.use.${operation}`));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* close(current);
      yield* Effect.logInfo("Closed the durable harness", { generation: current.generation });
    }),
  );

  return DurableHarness.of({
    models: options.models,
    defaultModel: options.defaultModel,
    install: (extension) =>
      Effect.sync(() => registry.install(extension)).pipe(
        Effect.tap(() =>
          Effect.logDebug("Installed a durable extension", { name: extension.name }),
        ),
      ),
    resume: Effect.gen(function* () {
      const target = yield* opened;
      yield* Effect.try({
        try: () => target.harness.resume(),
        catch: (cause) => durableError("resume", cause),
      });
      resumed = true;
      yield* Effect.logInfo("Resumed durable task scheduling", { generation: target.generation });
    }),
    use,
    subscribe: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => listeners.add(listener)),
        () => Effect.sync(() => listeners.delete(listener)),
      ).pipe(Effect.asVoid),
  });
});

/** Opens the harness for the layer's lifetime; it is closed, without writing any task outcome, when the layer ends. */
export const layer = (
  options: DurableHarnessOptions,
): Layer.Layer<DurableHarness, DurableHarnessError> => Layer.effect(DurableHarness, make(options));
