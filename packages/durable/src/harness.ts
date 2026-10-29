import type { Context as ChordContext } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type CommitPublication,
  createRegistry,
  type Extension,
  Harness,
  type ModelRef,
  SessionFailed,
  type Storage,
} from "@earendil-works/pi-durable";
import { Context, Deferred, Effect, Layer, Option, Result, Schema, type Scope } from "effect";

/** A failed pi-durable call. */
export class DurableHarnessError extends Schema.TaggedError<DurableHarnessError>(
  "@usine/durable/DurableHarnessError",
)("DurableHarnessError", {
  /**
   * A description of the failed operation, such as `open the durable harness`, or the
   * `operation` passed to `use`.
   */
  operation: Schema.NonEmptyString,
  /** The error message, or the storage error's message if a storage error failed the harness. */
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/**
 * A storage error that failed the pi-durable Session. pi-durable then aborts the harness's running
 * tasks and closes it, and every later call on it fails.
 */
export class DurableStorageFailed extends Schema.TaggedError<DurableStorageFailed>(
  "@usine/durable/DurableStorageFailed",
)("DurableStorageFailed", {
  /** The failed harness's generation: 1 for the first open, and one more for each reopen. */
  generation: Schema.Int,
  /** The storage error's message. */
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/** Callbacks for harness events, kept across reopens. */
export interface HarnessListener {
  /**
   * Runs synchronously after every adopted commit, so it must not block, throw, or call the
   * harness.
   */
  readonly onCommit: (publication: CommitPublication) => void;
  /**
   * Runs once a failed harness has closed, before the reopened one resumes its tasks. It must not
   * block or throw.
   */
  readonly onFailure: (failure: DurableStorageFailed) => void;
}

/**
 * A storage repair that runs on a newly opened harness before its tasks resume. `storage` is the
 * storage that the harness opened. A failed read through it fails only that read; a failed read
 * through `harness` fails the harness. It must log its own failures and never fail.
 */
export type BeforeResume = (harness: Harness, storage: Storage) => Effect.Effect<void>;

export interface DurableHarnessOptions {
  /** Opens the storage. Runs again on each reopen. */
  readonly openStorage: Effect.Effect<Storage, DurableHarnessError>;
  /** The pi-ai model access for generation and parent model resolution. */
  readonly models: Models;
  /**
   * The parent model for Attempts that name none. If `None`, the first model with a configured
   * credential is used.
   */
  readonly defaultModel: Option.Option<ModelRef>;
}

/**
 * The pi-durable Harness over one storage. After a storage error fails the harness, reopens the
 * storage and resumes the tasks, unless `resume` hasn't completed yet. Stops if the reopen fails
 * or if the reopened harness fails within a minute.
 */
export class DurableHarness extends Context.Service<
  DurableHarness,
  {
    readonly models: Models;
    readonly defaultModel: Option.Option<ModelRef>;
    /**
     * Installs or replaces an extension. Conversations that select it use the new code from their
     * next phase.
     */
    readonly install: (extension: Extension) => Effect.Effect<void>;
    /**
     * Runs `beforeResume`, then starts the task scheduler, and repeats both on each reopen. Call it
     * after installing all extensions. Fails with the storage error if one fails the harness first.
     */
    readonly resume: (beforeResume: BeforeResume) => Effect.Effect<void, DurableHarnessError>;
    /**
     * Runs a call against the open harness. If a storage error fails the harness during the call,
     * waits for the reopened harness and runs the call once more, so the call must be safe to
     * repeat. Fails with the storage error before `resume` completes and after the harness stops.
     */
    readonly use: <A>(
      operation: string,
      run: (harness: Harness, context: ChordContext) => Promise<A>,
    ) => Effect.Effect<A, DurableHarnessError>;
    /** Registers `listener` until the scope closes. */
    readonly subscribe: (listener: HarnessListener) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@usine/durable/DurableHarness") {}

/** The interval in which repeats of a reported failure are counted and then logged once. */
const REPORT_LOG_INTERVAL_MILLIS = 5_000;

/** A reopened harness that fails within this time stops instead of reopening. */
const REFAIL_MILLIS = 60_000;

const RESUME_OPERATION = "resume the durable tasks";

const messageOf = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause) || "unknown";

/**
 * Returns a `DurableHarnessError` with the message of `cause`. For a `SessionFailed`, uses the
 * message of the storage error that failed the harness.
 */
export const durableError = (operation: string, cause: unknown) =>
  new DurableHarnessError({
    operation,
    message: messageOf(cause instanceof SessionFailed ? cause.cause : cause),
    cause,
  });

/** The repeat counts of one reported failure. */
interface Repeats {
  /** The reports not yet logged. */
  unlogged: number;
  loggedAt: number;
}

/** The state of one opened harness. */
interface Generation {
  readonly number: number;
  /** The reported failures by message. */
  readonly reports: Map<string, Repeats>;
  /** Set before this process closes the harness, so the close isn't taken for a failure. */
  closing: boolean;
  /** Set when pi-durable starts closing the harness by itself, after a storage error. */
  failing: boolean;
  /** Set once the failure is handled. */
  handled: boolean;
}

interface Opened {
  readonly generation: Generation;
  readonly harness: Harness;
  readonly storage: Storage;
  readonly openedAt: number;
}

const make = Effect.fn("DurableHarness.make")(function* (options: DurableHarnessOptions) {
  const services = yield* Effect.context<never>();
  const fork = Effect.runForkWith(services);
  const scope = yield* Effect.scope;
  const registry = createRegistry();
  const listeners = new Set<HarnessListener>();
  let resumed = Option.none<BeforeResume>();
  let finalizing = false;
  let stopped = false;
  /**
   * Set while the current harness has failed. Succeeds with the reopened harness, or fails with the
   * storage failure if no reopen follows.
   */
  let failed = Option.none<Deferred.Deferred<Opened, DurableStorageFailed>>();

  const logRepeats = (generation: number, message: string, repeats: Repeats) => {
    fork(
      Effect.logWarning("pi-durable reported the same failure again", {
        generation,
        cause: message,
        repeats: repeats.unlogged,
      }),
    );
    repeats.unlogged = 0;
    repeats.loggedAt = Date.now();
  };

  // Called synchronously from inside pi-durable.
  function report(generation: Generation, cause: unknown) {
    const message = messageOf(cause);
    // pi-durable also reports the error that fails the Session; the failure handling logs it.
    if (generation.failing) {
      fork(
        Effect.logDebug("pi-durable reported a failure of a failed harness", {
          generation: generation.number,
          cause: message,
        }),
      );
      return;
    }
    const repeats = generation.reports.get(message);
    if (repeats === undefined) {
      generation.reports.set(message, { unlogged: 0, loggedAt: Date.now() });
      fork(
        Effect.logWarning("pi-durable reported a failure that did not fail its caller", {
          generation: generation.number,
          cause: message,
        }),
      );
      return;
    }
    repeats.unlogged += 1;
    if (Date.now() - repeats.loggedAt >= REPORT_LOG_INTERVAL_MILLIS) {
      logRepeats(generation.number, message, repeats);
    }
  }

  const open = Effect.fn("DurableHarness.open")(function* (number: number) {
    yield* Effect.annotateCurrentSpan({ generation: number });
    const storage = yield* options.openStorage;
    const generation: Generation = {
      number,
      reports: new Map(),
      closing: false,
      failing: false,
      handled: false,
    };
    const harness = yield* Effect.tryPromise({
      try: () =>
        Harness.open(
          storage,
          {
            models: options.models,
            registry,
            settings: { restartLimit: Infinity },
            onReport: (error) => report(generation, error),
          },
          BACKGROUND_CONTEXT,
        ),
      catch: (cause) => durableError("open the durable harness", cause),
    });
    const opened: Opened = { generation, harness, storage, openedAt: Date.now() };
    harness.subscribeClose(() => {
      if (generation.closing) return;
      generation.failing = true;
      handleFailure(opened);
    });
    harness.subscribeCommits((publication) => {
      for (const [message, repeats] of generation.reports) {
        if (repeats.unlogged === 0) generation.reports.delete(message);
      }
      for (const listener of listeners) listener.onCommit(publication);
    });
    if (Option.isSome(resumed)) {
      yield* resumed.value(harness, storage);
      yield* Effect.try({
        try: () => harness.resume(),
        catch: (cause) => durableError(RESUME_OPERATION, cause),
      });
    }
    yield* Effect.logInfo("Opened the durable harness", {
      generation: number,
      resumed: Option.isSome(resumed),
    });
    return opened;
  });

  const flushReports = (generation: Generation) => {
    for (const [message, repeats] of generation.reports) {
      if (repeats.unlogged > 0) logRepeats(generation.number, message, repeats);
    }
  };

  const close = Effect.fn("DurableHarness.close")(function* (opened: Opened) {
    const generation = opened.generation;
    yield* Effect.annotateCurrentSpan({ generation: generation.number });
    generation.closing = true;
    flushReports(generation);
    yield* Effect.tryPromise({
      try: () => opened.harness.close(BACKGROUND_CONTEXT),
      catch: (cause) => durableError("close", cause),
    }).pipe(
      Effect.tapError((error) =>
        Effect.logError("Could not close the durable harness", {
          generation: generation.number,
          message: error.message,
        }),
      ),
      Effect.ignore,
    );
  });

  const stop = Effect.fn("DurableHarness.stop")(function* (
    failure: DurableStorageFailed,
    ready: Deferred.Deferred<Opened, DurableStorageFailed>,
  ) {
    stopped = true;
    yield* Effect.logError(
      "Stopped the durable harness: the storage failed again on reopening; durable calls fail until the orchestrator restarts",
      { generation: failure.generation, cause: failure.message },
    );
    yield* Deferred.fail(ready, failure);
  });

  const reopen = Effect.fn("DurableHarness.reopen")(function* (
    previous: Opened,
    ready: Deferred.Deferred<Opened, DurableStorageFailed>,
  ) {
    const number = previous.generation.number + 1;
    yield* Effect.annotateCurrentSpan({ generation: number });
    yield* Effect.logInfo("Reopening the durable harness", { generation: number });
    const next = yield* open(number).pipe(Effect.result);
    if (Result.isFailure(next)) {
      return yield* stop(
        new DurableStorageFailed({
          generation: number,
          message: next.failure.message,
          cause: next.failure,
        }),
        ready,
      );
    }
    current = next.success;
    failed = Option.none();
    yield* Deferred.succeed(ready, next.success);
    yield* Effect.logInfo("Reopened the durable harness", { generation: number });
    // A failure while opening found another harness current.
    if (next.success.generation.failing) handleFailure(next.success);
  }, Effect.uninterruptible);

  /** Waits until the failed harness has closed, then reopens it or completes `ready` with the failure. */
  const recover = Effect.fn("DurableHarness.recover")(function* (
    opened: Opened,
    ready: Deferred.Deferred<Opened, DurableStorageFailed>,
  ) {
    const number = opened.generation.number;
    yield* Effect.annotateCurrentSpan({ generation: number });
    const end = yield* Effect.promise(() => opened.harness.closed);
    flushReports(opened.generation);
    const cause = end.reason === "failed" ? end.error : new Error("pi-durable closed the harness");
    const failure = new DurableStorageFailed({
      generation: number,
      message: messageOf(cause),
      cause,
    });
    yield* Effect.logError("A storage error failed the durable harness, and pi-durable closed it", {
      generation: number,
      cause: failure.message,
    });
    for (const listener of listeners) listener.onFailure(failure);
    if (finalizing) return yield* Deferred.fail(ready, failure);
    if (Option.isNone(resumed)) {
      yield* Effect.logError(
        "The durable harness failed before its tasks resumed; it stays closed",
        {
          generation: number,
          cause: failure.message,
        },
      );
      return yield* Deferred.fail(ready, failure);
    }
    if (number > 1 && Date.now() - opened.openedAt < REFAIL_MILLIS) {
      return yield* stop(failure, ready);
    }
    yield* reopen(opened, ready);
  });

  let current = yield* open(1);

  // Called synchronously from inside pi-durable; the recovery runs on its own fiber.
  function handleFailure(opened: Opened) {
    if (opened.generation.handled || opened !== current || Option.isSome(failed)) return;
    opened.generation.handled = true;
    const ready = Deferred.makeUnsafe<Opened, DurableStorageFailed>();
    failed = Option.some(ready);
    fork(recover(opened, ready).pipe(Effect.forkIn(scope)));
  }

  /** Returns the open harness, waiting for a reopen. Fails if the harness stays closed. */
  const openHarness = (operation: string): Effect.Effect<Opened, DurableHarnessError> =>
    Effect.suspend(() =>
      Option.match(failed, {
        onNone: () => Effect.succeed(current),
        onSome: (ready) =>
          Deferred.await(ready).pipe(
            Effect.mapError(
              (failure) =>
                new DurableHarnessError({
                  operation,
                  message: stopped
                    ? `The durable harness stopped after repeated storage errors: ${failure.message}. Restart the orchestrator.`
                    : failure.message,
                  cause: failure,
                }),
            ),
          ),
      }),
    );

  /** Whether `cause` failed the call because a storage error failed `opened`'s harness. */
  const failedHarness = (opened: Opened, cause: unknown): boolean =>
    opened.generation.failing || cause instanceof SessionFailed;

  const use = <A>(
    operation: string,
    run: (harness: Harness, context: ChordContext) => Promise<A>,
  ): Effect.Effect<A, DurableHarnessError> =>
    Effect.gen(function* () {
      for (let attempt = 1; ; attempt += 1) {
        const target = yield* openHarness(operation);
        const outcome = yield* Effect.tryPromise({
          try: (signal) => run(target.harness, withAbortSignal(signal, BACKGROUND_CONTEXT)),
          catch: (cause) => cause,
        }).pipe(Effect.result);
        if (Result.isSuccess(outcome)) return outcome.success;
        const cause = outcome.failure;
        if (!failedHarness(target, cause)) return yield* durableError(operation, cause);
        if (attempt === 1) {
          yield* Effect.logInfo("Repeating a durable call after its harness failed", {
            operation,
            generation: target.generation.number,
          });
          continue;
        }
        return yield* durableError(operation, cause);
      }
    }).pipe(Effect.withSpan(`DurableHarness.use.${operation}`));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      finalizing = true;
      yield* close(current);
      yield* Effect.logInfo("Closed the durable harness", {
        generation: current.generation.number,
      });
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
    resume: Effect.fn("DurableHarness.resume")(function* (beforeResume: BeforeResume) {
      const target = yield* openHarness(RESUME_OPERATION);
      yield* beforeResume(target.harness, target.storage);
      const started = yield* Effect.try({
        try: () => target.harness.resume(),
        catch: (cause) => cause,
      }).pipe(Effect.result);
      if (Result.isFailure(started)) {
        if (failedHarness(target, started.failure)) yield* openHarness(RESUME_OPERATION);
        return yield* durableError(RESUME_OPERATION, started.failure);
      }
      resumed = Option.some(beforeResume);
      yield* Effect.logInfo("Resumed durable task scheduling", {
        generation: target.generation.number,
      });
    }),
    use,
    subscribe: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => listeners.add(listener)),
        () => Effect.sync(() => listeners.delete(listener)),
      ).pipe(Effect.asVoid),
  });
});

/**
 * Opens the harness for the layer's lifetime. Closes it on release without writing any task
 * outcome.
 */
export const layer = (
  options: DurableHarnessOptions,
): Layer.Layer<DurableHarness, DurableHarnessError> => Layer.effect(DurableHarness, make(options));
