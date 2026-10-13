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
  /** Runs once a poisoned or stuck Session has been replaced by a freshly opened and resumed harness. */
  readonly onReopen: () => void;
  /** Runs once the harness has stopped for good; every later call fails with the reason. */
  readonly onStop: () => void;
}

/** Repairs storage through a freshly opened harness before its tasks run; it logs its own failures and never fails. */
export type BeforeResume = (harness: Harness) => Effect.Effect<void>;

/** What the harness runs on. */
export interface DurableHarnessOptions {
  /** Opens the storage; run again to reopen after a poisoned or stuck Session. */
  readonly openStorage: Effect.Effect<Storage, DurableHarnessError>;
  /** pi-ai model access for generation and parent model resolution. */
  readonly models: Models;
  /** The parent model when an Attempt names none; absent means the first model with a configured credential. */
  readonly defaultModel: Option.Option<ModelRef>;
}

/**
 * The orchestrator's pi-durable Harness over one storage. A commit that fails
 * after storage admission poisons the whole Session; the harness detects it,
 * closes the Session, opens the storage again, and resumes its tasks. A step
 * pi-durable keeps retrying without progress is handled the same way, and
 * stops the harness for good when the reopened harness gets stuck again.
 */
export class DurableHarness extends Context.Service<
  DurableHarness,
  {
    readonly models: Models;
    readonly defaultModel: Option.Option<ModelRef>;
    /** Installs or replaces an extension; conversations that select it by name use the new code from their next phase. */
    readonly install: (extension: Extension) => Effect.Effect<void>;
    /**
     * Runs `beforeResume` on the open harness, then starts the task scheduler;
     * every reopen does both again. Call it once every extension is installed:
     * a generation resumed earlier would be prepared without the tools its
     * conversation selects.
     */
    readonly resume: (beforeResume: BeforeResume) => Effect.Effect<void, DurableHarnessError>;
    /**
     * Runs one call against the open harness. A call that fails because the
     * Session was poisoned or replaced runs once more on the reopened harness,
     * so it must be safe to repeat. Once the harness has stopped, every call
     * fails with the reason it stopped.
     */
    readonly use: <A>(
      operation: string,
      run: (harness: Harness, context: ChordContext) => Promise<A>,
    ) => Effect.Effect<A, DurableHarnessError>;
    /** Observes commits, reopens, and the stop while the scope is open. */
    readonly subscribe: (listener: HarnessListener) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@usine/durable/DurableHarness") {}

const POISONED_MESSAGE = "Session is poisoned";

/** pi-durable reports a poisoned Session only through this message. */
const isPoisoned = (cause: unknown): boolean =>
  cause instanceof Error && cause.message.startsWith(POISONED_MESSAGE);

/** A failure pi-durable reports again within this interval is counted, then logged once with its count. */
const REPORT_LOG_INTERVAL_MILLIS = 5_000;

/**
 * How many reports of one failure, with no commit adopted between them, mean
 * pi-durable keeps retrying a step that cannot succeed. Its scheduler retries
 * such a step at once, in microtasks, so until the harness closes the process
 * runs no timer and no I/O. Provide another value to change it.
 */
export const StuckStepReports = Context.Reference<number>("@usine/durable/StuckStepReports", {
  defaultValue: () => 1_000,
});

/** A harness opened in place of a stuck one that gets stuck within this time is stopped instead of reopened. */
const STUCK_AGAIN_MILLIS = 60_000;

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

/** How often one reported failure came back since it was last logged. */
interface Repeats {
  /** Reports since the last adopted commit. */
  count: number;
  /** Reports not logged yet. */
  unlogged: number;
  loggedAt: number;
}

interface Opened {
  readonly generation: number;
  readonly harness: Harness;
  readonly openedAt: number;
  /** Opened in place of a harness whose step got stuck. */
  readonly afterStuck: boolean;
  /** Reported failures by message. */
  readonly reports: Map<string, Repeats>;
}

type ReopenReason = "poisoned" | "stuck";

const make = Effect.fn("DurableHarness.make")(function* (options: DurableHarnessOptions) {
  const services = yield* Effect.context<never>();
  const fork = Effect.runForkWith(services);
  const stuckStepReports = yield* StuckStepReports;
  const scope = yield* Effect.scope;
  const registry = createRegistry();
  const listeners = new Set<HarnessListener>();
  let resumed = Option.none<BeforeResume>();
  let started = false;
  let closed = false;
  let reopening = Option.none<Deferred.Deferred<Opened>>();
  let stopped = Option.none<Error>();

  const open = Effect.fn("DurableHarness.open")(function* (
    generation: number,
    afterStuck: boolean,
  ) {
    yield* Effect.annotateCurrentSpan({ generation });
    const storage = yield* options.openStorage;
    const reports = new Map<string, Repeats>();
    const harness = yield* Effect.tryPromise({
      try: () =>
        Harness.open(
          watchCommits(storage, (cause) => requestReopen(generation, cause, "poisoned")),
          {
            models: options.models,
            registry,
            onReport: (error) => report(generation, reports, error),
          },
          BACKGROUND_CONTEXT,
        ),
      catch: (cause) => durableError("open", cause),
    });
    harness.subscribeCommits((publication) => {
      for (const [message, repeats] of reports) {
        if (repeats.unlogged === 0) reports.delete(message);
        else repeats.count = 0;
      }
      for (const listener of listeners) listener.onCommit(publication);
    });
    if (Option.isSome(resumed)) {
      yield* resumed.value(harness);
      harness.resume();
    }
    yield* Effect.logInfo("Opened the durable harness", {
      generation,
      resumed: Option.isSome(resumed),
    });
    return {
      generation,
      harness,
      openedAt: Date.now(),
      afterStuck,
      reports,
    } satisfies Opened;
  });

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

  const close = Effect.fn("DurableHarness.close")(function* (opened: Opened) {
    yield* Effect.annotateCurrentSpan({ generation: opened.generation });
    for (const [message, repeats] of opened.reports) {
      if (repeats.unlogged > 0) logRepeats(opened.generation, message, repeats);
    }
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

  const reopen = Effect.fn("DurableHarness.reopen")(function* (
    previous: Opened,
    cause: unknown,
    ready: Deferred.Deferred<Opened>,
    reason: ReopenReason,
  ) {
    yield* Effect.annotateCurrentSpan({ generation: previous.generation, reason });
    yield* Effect.logError(
      reason === "poisoned"
        ? "A durable commit failed after storage admission and poisoned the Session; reopening the harness"
        : "pi-durable keeps retrying a step that cannot succeed; reopening the harness",
      { generation: previous.generation, cause: messageOf(cause) },
    );
    yield* close(previous);
    const next = yield* open(previous.generation + 1, reason === "stuck").pipe(
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
    yield* Effect.logInfo("Reopened the durable harness", { generation: next.generation, reason });
  });

  let current = yield* open(1, false);
  started = true;

  // Called synchronously from inside pi-durable; the reopen runs on its own fiber.
  function requestReopen(generation: number, cause: unknown, reason: ReopenReason) {
    if (!started || closed || Option.isSome(stopped) || Option.isSome(reopening)) return;
    if (current.generation !== generation) return;
    const ready = Deferred.makeUnsafe<Opened>();
    reopening = Option.some(ready);
    fork(reopen(current, cause, ready, reason).pipe(Effect.forkIn(scope)));
  }

  function stop(target: Opened, cause: unknown) {
    stopped = Option.some(
      new Error(`pi-durable keeps retrying a step that fails with: ${messageOf(cause)}`, { cause }),
    );
    fork(
      Effect.logError(
        "Stopped the durable harness: pi-durable kept retrying a step that cannot succeed, also on a reopened harness; durable calls fail until the orchestrator restarts",
        { generation: target.generation, cause: messageOf(cause) },
      ),
    );
    for (const listener of listeners) listener.onStop();
    fork(close(target).pipe(Effect.forkIn(scope)));
  }

  function stuck(generation: number, cause: unknown) {
    if (!started || closed || Option.isSome(stopped) || Option.isSome(reopening)) return;
    if (current.generation !== generation) return;
    const target = current;
    // Closed here because no fiber runs while pi-durable retries in microtasks; the reopen or the stop closes it again and logs the outcome.
    void target.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    if (target.afterStuck && Date.now() - target.openedAt < STUCK_AGAIN_MILLIS) stop(target, cause);
    else requestReopen(generation, cause, "stuck");
  }

  // Called synchronously from inside pi-durable, possibly thousands of times a second.
  function report(generation: number, reports: Map<string, Repeats>, cause: unknown) {
    const message = messageOf(cause);
    const repeats = reports.get(message);
    if (repeats === undefined) {
      reports.set(message, { count: 1, unlogged: 0, loggedAt: Date.now() });
      fork(
        Effect.logWarning("pi-durable reported a failure that did not fail its caller", {
          generation,
          cause: message,
        }),
      );
    } else {
      repeats.count += 1;
      repeats.unlogged += 1;
      if (Date.now() - repeats.loggedAt >= REPORT_LOG_INTERVAL_MILLIS) {
        logRepeats(generation, message, repeats);
      }
    }
    if (isPoisoned(cause)) requestReopen(generation, cause, "poisoned");
    else if ((repeats?.count ?? 1) >= stuckStepReports) stuck(generation, cause);
  }

  /** Fails with the reason the harness stopped, if it has. */
  const unlessStopped = (operation: string): Effect.Effect<void, DurableHarnessError> =>
    Option.match(stopped, {
      onNone: () => Effect.void,
      onSome: (reason) => Effect.fail(durableError(operation, reason)),
    });

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
        yield* unlessStopped(operation);
        const target = yield* opened;
        const outcome = yield* Effect.tryPromise({
          try: (signal) => run(target.harness, withAbortSignal(signal, BACKGROUND_CONTEXT)),
          catch: (cause) => cause,
        }).pipe(Effect.result);
        if (Result.isSuccess(outcome)) return outcome.success;
        const cause = outcome.failure;
        yield* unlessStopped(operation);
        if (isPoisoned(cause)) requestReopen(target.generation, cause, "poisoned");
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
    resume: Effect.fn("DurableHarness.resume")(function* (beforeResume: BeforeResume) {
      yield* unlessStopped("resume");
      const target = yield* opened;
      yield* beforeResume(target.harness);
      yield* Effect.try({
        try: () => target.harness.resume(),
        catch: (cause) => durableError("resume", cause),
      });
      resumed = Option.some(beforeResume);
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
