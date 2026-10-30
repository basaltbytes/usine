import type { RunId } from "@usine/core/run";
import type { ReleaseVersion } from "@usine/core/upgrade";
import { Context, DateTime, Deferred, Effect, Layer, Option, Ref, type Scope } from "effect";
import { RunEngineShutdown } from "./shutdown.ts";
import { UpgradeDrain, UpgradeWait } from "./upgrade.ts";

interface UpgradePause {
  readonly wait: UpgradeWait;
  readonly empty: Deferred.Deferred<void>;
}

/** Coordinates worker reservations, attempt admission, and outcome persistence. */
export class AttemptAdmission extends Context.Service<
  AttemptAdmission,
  {
    readonly withAttempt: <A, E, R, B, E2, R2>(
      runId: RunId,
      reserve: Effect.Effect<A, E, R | Scope.Scope>,
      attempt: (resource: A) => Effect.Effect<B, E2, R2>,
    ) => Effect.Effect<B, E | E2, Exclude<R, Scope.Scope> | R2>;
    readonly drain: () => Effect.Effect<void>;
    readonly waitForUpgrade: (target: ReleaseVersion) => Effect.Effect<void>;
    readonly cancelUpgrade: Effect.Effect<void>;
    readonly upgradeDrain: Effect.Effect<Option.Option<UpgradeDrain>>;
  }
>()("@usine/engine/AttemptAdmission") {
  static readonly layer = Layer.effect(
    AttemptAdmission,
    Effect.gen(function* () {
      const hostShutdown = yield* Effect.serviceOption(RunEngineShutdown);
      const shutdown = Option.isSome(hostShutdown)
        ? hostShutdown.value
        : yield* Deferred.make<void>();
      const active = yield* Ref.make<ReadonlySet<RunId>>(new Set());
      const waiting = yield* Ref.make<ReadonlySet<RunId>>(new Set());
      const empty = yield* Deferred.make<void>();
      const gate = yield* Ref.make({
        upgrade: Option.none<UpgradePause>(),
        changed: yield* Deferred.make<void>(),
      });

      const enter = Effect.fn("AttemptAdmission.enter")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        return yield* Ref.modify(active, (current) =>
          Deferred.isDoneUnsafe(shutdown) || Option.isSome(Ref.getUnsafe(gate).upgrade)
            ? ([false, current] as const)
            : ([true, new Set([...current, runId])] as const),
        );
      });

      const leave = Effect.fn("AttemptAdmission.leave")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const remaining = yield* Ref.updateAndGet(
          active,
          (current) => new Set([...current].filter((id) => id !== runId)),
        );
        const { upgrade } = yield* Ref.get(gate);
        if ((yield* Deferred.isDone(shutdown)) || Option.isSome(upgrade)) {
          yield* Effect.logInfo("Attempt settled during drain", {
            runId,
            remainingRunIds: [...remaining],
          });
          if (remaining.size === 0) {
            if (yield* Deferred.isDone(shutdown)) yield* Deferred.succeed(empty, undefined);
            if (Option.isSome(upgrade)) yield* Deferred.succeed(upgrade.value.empty, undefined);
          }
        }
      });

      const withAttempt = Effect.fn("AttemptAdmission.withAttempt")(function* <A, E, R, B, E2, R2>(
        runId: RunId,
        reserve: Effect.Effect<A, E, R | Scope.Scope>,
        attempt: (resource: A) => Effect.Effect<B, E2, R2>,
      ) {
        yield* Effect.annotateCurrentSpan({ runId });
        const removeWaiting = Ref.update(
          waiting,
          (runs) => new Set([...runs].filter((id) => id !== runId)),
        );
        return yield* Effect.acquireUseRelease(
          Ref.update(waiting, (runs) => new Set([...runs, runId])),
          () =>
            Effect.gen(function* () {
              while (true) {
                const current = yield* Ref.get(gate);
                if (yield* Deferred.isDone(shutdown)) return yield* Effect.never;
                if (Option.isSome(current.upgrade)) {
                  yield* Deferred.await(current.changed);
                  continue;
                }
                const result = yield* Effect.scoped(
                  Effect.gen(function* () {
                    // Reservations and admission both register cleanup in this scope, including a
                    // reservation that completes just as the drain wins the race.
                    const prepared = yield* Effect.raceFirst(
                      reserve.pipe(
                        Effect.flatMap((resource) =>
                          Effect.acquireRelease(enter(runId), (admitted) =>
                            admitted ? leave(runId) : Effect.void,
                          ).pipe(
                            Effect.map((admitted) =>
                              admitted ? Option.some(resource) : Option.none<A>(),
                            ),
                          ),
                        ),
                      ),
                      Effect.raceFirst(
                        Deferred.await(shutdown),
                        Deferred.await(current.changed),
                      ).pipe(Effect.as(Option.none<A>())),
                    );
                    if (Option.isNone(prepared)) return Option.none<B>();
                    yield* removeWaiting;
                    return Option.some(yield* attempt(prepared.value));
                  }),
                );
                if (Option.isSome(result)) return result.value;
              }
            }),
          () => removeWaiting,
        );
      });

      const waitForUpgrade = Effect.fn("AttemptAdmission.waitForUpgrade")(function* (
        target: ReleaseVersion,
      ) {
        const wait = new UpgradeWait({ target, since: yield* DateTime.now });
        const pause = { wait, empty: yield* Deferred.make<void>() };
        const next = { upgrade: Option.some(pause), changed: yield* Deferred.make<void>() };
        const previous = yield* Ref.modify(gate, (current) => [
          current,
          Option.isSome(current.upgrade) ? current : next,
        ]);
        if (Option.isSome(previous.upgrade)) {
          yield* Effect.logDebug("Joining the pending upgrade drain", {
            target: previous.upgrade.value.wait.target,
          });
          return previous.upgrade.value.empty;
        }
        yield* Deferred.succeed(previous.changed, undefined);
        yield* Effect.annotateCurrentSpan({ target });
        yield* Effect.logWarning("Idle upgrade defers new attempts until restart or cancellation", {
          target,
          deferredRuns: (yield* Ref.get(waiting)).size,
          activeRunIds: [...(yield* Ref.get(active))],
        });
        if ((yield* Ref.get(active)).size === 0) yield* Deferred.succeed(pause.empty, undefined);
        return pause.empty;
      }, Effect.uninterruptible);

      const cancelUpgrade = Effect.fn("AttemptAdmission.cancelUpgrade")(function* () {
        const previous = yield* Ref.getAndSet(gate, {
          upgrade: Option.none(),
          changed: yield* Deferred.make<void>(),
        });
        yield* Deferred.succeed(previous.changed, undefined);
        if (Option.isSome(previous.upgrade)) {
          yield* Effect.annotateCurrentSpan({ target: previous.upgrade.value.wait.target });
          yield* Effect.logInfo("Upgrade wait canceled", {
            target: previous.upgrade.value.wait.target,
            shuttingDown: yield* Deferred.isDone(shutdown),
            deferredRuns: (yield* Ref.get(waiting)).size,
          });
        }
      }, Effect.uninterruptible);

      const drain = Effect.fn("AttemptAdmission.drain")(function* () {
        yield* Deferred.succeed(shutdown, undefined);
        const current = yield* Ref.get(active);
        yield* Effect.logInfo("Engine drain started; no further Attempts will be admitted", {
          activeRunIds: [...current],
        });
        if (current.size === 0) yield* Deferred.succeed(empty, undefined);
        yield* Deferred.await(empty);
        yield* Effect.logInfo("Engine drain completed; all admitted Attempts settled");
      });

      return {
        withAttempt,
        drain,
        waitForUpgrade: (target: ReleaseVersion) =>
          waitForUpgrade(target).pipe(Effect.flatMap(Deferred.await)),
        cancelUpgrade: cancelUpgrade(),
        upgradeDrain: Effect.gen(function* () {
          const { upgrade } = yield* Ref.get(gate);
          const runIds = [...(yield* Ref.get(waiting))];
          return Option.map(upgrade, ({ wait }) => new UpgradeDrain({ wait, runIds }));
        }),
      };
    }),
  );
}
