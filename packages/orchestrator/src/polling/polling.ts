import type { DeclaredLabel } from "@usine/config/label";
import type { LoadedInstance } from "@usine/config/instance";
import type { ManagedRepo } from "@usine/config/factory";
import { ConfigParser } from "@usine/config/parser";
import { matchesSelector } from "@usine/config/selector";
import { canonicalRepositoryName } from "@usine/core/repository";
import { CursorKey, CursorStore } from "@usine/engine/cursor";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import {
  RunEngine,
  type EnginePersistenceError,
  type SubmissionResult,
} from "@usine/engine/engine";
import { ItemProjectionWriter } from "@usine/engine/item-projection";
import { LoopControl } from "@usine/engine/loop-control";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "@usine/engine/repository-label-projection";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { EntityTag, PollCursor, GitHubPolling } from "@usine/github/polling";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from "effect";
import { LabelReconciler, type LabelPreflightFinding } from "../label-reconciler.ts";
import { type ResolvedLoop, resolveTriggerLoops } from "../trigger-submission.ts";
import {
  type InterruptedRepositoryCycle,
  latestPollAt,
  PollCycle,
  type RepositoryPollError,
  RepositoryPollFailure,
  repositoryFailureLogFields,
} from "./cycle.ts";
import { evaluateItem } from "./loop-evaluation.ts";
import { observeItem, synchronizeLabels } from "./repository-sync.ts";

/** GitHub tolerates a handful of parallel REST and GraphQL calls per token. */
const REPOSITORY_CONCURRENCY = 4;

const ITEM_CONCURRENCY = 4;

const WatchKey = Schema.NonEmptyString.pipe(Schema.brand("GitHubPollWatchKey"));
type WatchKey = typeof WatchKey.Type;

class StoredPollCursor extends Schema.Class<StoredPollCursor>(
  "@usine/orchestrator/StoredPollCursor",
)({
  boardVersion: Schema.Literal(4),
  cursor: PollCursor,
  labelEntityTag: Schema.OptionFromNullOr(EntityTag),
  watches: Schema.Array(WatchKey).check(Schema.isUnique()),
}) {}

interface WatchedRepository {
  readonly repository: ManagedRepo;
  readonly declaredLabels: ReadonlyArray<DeclaredLabel>;
  readonly loops: ReadonlyArray<ResolvedLoop>;
  readonly watches: ReadonlyArray<WatchKey>;
}

interface RepositoryCycle {
  readonly changedItems: number;
  readonly submissions: ReadonlyArray<SubmissionResult>;
  readonly revokedRuns: number;
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
  readonly preflightFindings: ReadonlyArray<LabelPreflightFinding>;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

const cursorKey = (repository: ManagedRepo): CursorKey =>
  CursorKey.make(`github-poll:${canonicalRepositoryName(repository.name)}`);

const watchKey = ({ loop }: ResolvedLoop): WatchKey =>
  WatchKey.make(JSON.stringify([loop.name, loop.trigger.on, loop.trigger.if]));

const watchedRepositories = (
  instance: LoadedInstance,
  resolved: ReadonlyArray<ResolvedLoop>,
): ReadonlyArray<WatchedRepository> =>
  instance.config.repos.map((repository) => {
    const loops = resolved.filter(
      ({ loop }) => loop.trigger.on !== "schedule" && matchesSelector(loop.selector, repository),
    );
    return {
      repository,
      declaredLabels: instance.config.labels,
      loops,
      watches: loops.map(watchKey).sort(),
    };
  });

const sameWatches = (left: ReadonlyArray<WatchKey>, right: ReadonlyArray<WatchKey>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Keeps managed repositories' Boards current and evaluates their active Loops against changed Items. */
export class PollingTriggers extends Context.Service<
  PollingTriggers,
  {
    /**
     * Polls every managed repository, including those without active Loops.
     * Label preflight precedes change detection; each changed Item is projected
     * before its Run decisions. A repository commits its cursor only after all
     * Items finish. Repository failures are reported while siblings continue;
     * failure to read Loop runtime state fails the whole cycle.
     */
    readonly poll: (instance: LoadedInstance) => Effect.Effect<PollCycle, EnginePersistenceError>;
    /** Repeats cycles at the configured interval, extending the delay for GitHub backoff until interrupted. */
    readonly run: (instance: LoadedInstance) => Effect.Effect<never>;
    /** The last completed cycle, including its isolated failures; absent until the first cycle completes. */
    readonly latest: Effect.Effect<Option.Option<PollCycle>>;
  }
>()("@usine/orchestrator/PollingTriggers") {
  static readonly layer = Layer.effect(
    PollingTriggers,
    Effect.gen(function* () {
      const cursors = yield* CursorStore;
      const budgets = yield* CycleBudgets;
      const github = yield* GitHubPolling;
      const loops = yield* LoopControl;
      const latest = yield* Ref.make(Option.none<PollCycle>());

      const emptyCursor = (watches: ReadonlyArray<WatchKey>) =>
        new StoredPollCursor({
          boardVersion: 4,
          cursor: PollCursor.empty,
          labelEntityTag: Option.none(),
          watches,
        });

      const readCursor = Effect.fn("PollingTriggers.readCursor")(function* (
        watched: WatchedRepository,
      ) {
        yield* Effect.annotateCurrentSpan({ repository: watched.repository.name });
        const stored = yield* cursors.read(cursorKey(watched.repository), StoredPollCursor);
        if (Option.isNone(stored)) return emptyCursor(watched.watches);
        if (!sameWatches(stored.value.watches, watched.watches)) {
          yield* Effect.logInfo("Watched loops changed; re-polling the repository from scratch", {
            repository: watched.repository.name,
            previousWatches: stored.value.watches.length,
            currentWatches: watched.watches.length,
          });
          return emptyCursor(watched.watches);
        }
        return stored.value;
      });

      const writeCursor = Effect.fn("PollingTriggers.writeCursor")(function* (
        watched: WatchedRepository,
        cursor: StoredPollCursor,
      ) {
        yield* Effect.annotateCurrentSpan({ repository: watched.repository.name });
        yield* cursors.write(cursorKey(watched.repository), StoredPollCursor, cursor);
      });

      const pollRepository = Effect.fn("PollingTriggers.pollRepository")(function* (
        watched: WatchedRepository,
      ) {
        yield* Effect.annotateCurrentSpan({ repository: watched.repository.name });
        const resets = (yield* budgets.pendingResets()).filter(
          ({ repository }) =>
            canonicalRepositoryName(repository) ===
            canonicalRepositoryName(watched.repository.name),
        );
        const stored =
          resets.length > 0 ? emptyCursor(watched.watches) : yield* readCursor(watched);
        if (resets.length > 0)
          yield* Effect.logInfo("Cycle budget reset requests fresh repository polling", {
            repository: watched.repository.name,
            items: resets.map(({ itemKey }) => itemKey),
          });
        const preflight = yield* synchronizeLabels(
          watched.repository.name,
          watched.declaredLabels,
          stored.labelEntityTag,
        );
        return yield* Effect.gen(function* () {
          // Label creation finishes before change detection and Item evaluation
          // begin, including on the first cycle after `usine up`.
          const detected = yield* github.changes(watched.repository.name, stored.cursor);
          const nextCursor = new StoredPollCursor({
            boardVersion: 4,
            cursor: detected.cursor,
            labelEntityTag: preflight.labelEntityTag,
            watches: watched.watches,
          });
          const nextPollAt = latestPollAt([detected.nextPollAt, preflight.nextPollAt]);
          if (detected._tag === "RepositoryNotModified") {
            if (preflight.entityTagChanged) {
              yield* writeCursor(watched, nextCursor);
            }
            yield* Effect.logDebug("Repository unchanged (304)", {
              repository: watched.repository.name,
            });
            return {
              changedItems: 0,
              submissions: [],
              revokedRuns: 0,
              failures: preflight.failures,
              preflightFindings: preflight.preflightFindings,
              nextPollAt,
            } satisfies RepositoryCycle;
          }

          yield* Effect.logInfo("Repository changed", {
            repository: watched.repository.name,
            changedItems: detected.items.length,
            backlog: detected.backlog,
          });
          const itemCycles = yield* Effect.forEach(
            detected.items,
            (item) =>
              observeItem(watched.repository.name, item).pipe(
                Effect.flatMap((projection) =>
                  evaluateItem(watched.repository, watched.loops, projection),
                ),
              ),
            { concurrency: ITEM_CONCURRENCY },
          );
          // Advancing the cursor is the commit point: every changed item was
          // fetched, evaluated, and submitted or revoked. After a failure the
          // old cursor stays so the next cycle re-polls.
          yield* writeCursor(watched, nextCursor);
          yield* Effect.forEach(resets, budgets.acknowledgeReset, { discard: true });
          return {
            changedItems: detected.items.length,
            submissions: itemCycles.flatMap(({ submissions }) => submissions),
            revokedRuns: itemCycles.reduce((sum, cycle) => sum + cycle.revokedRuns, 0),
            failures: [...preflight.failures, ...itemCycles.flatMap(({ failures }) => failures)],
            preflightFindings: preflight.preflightFindings,
            nextPollAt,
          } satisfies RepositoryCycle;
        }).pipe(
          Effect.mapError((error): InterruptedRepositoryCycle => ({
            _tag: "InterruptedRepositoryCycle",
            error,
            failures: preflight.failures,
            preflightFindings: preflight.preflightFindings,
            nextPollAt: preflight.nextPollAt,
          })),
        );
      });

      // Bind only dependencies, preserving the caller's clock, logging and
      // tracing context on each cycle instead of capturing them at layer build.
      const repositoryServices = (yield* Effect.context<
        Effect.Services<ReturnType<typeof pollRepository>>
      >()).pipe(
        Context.pick(
          ConfigParser,
          CycleBudgets,
          ExpressionEngine,
          GitHubPolling,
          ItemProjectionWriter,
          LabelReconciler,
          RepositoryLabelProjectionReader,
          RepositoryLabelProjectionWriter,
          RunEngine,
        ),
      );

      const poll = Effect.fn("PollingTriggers.poll")(function* (instance: LoadedInstance) {
        const paused = new Set(
          (yield* loops.states).filter((state) => state.paused).map((state) => state.loop),
        );
        for (const loop of instance.loops) {
          if (loop.trigger.on !== "schedule" && paused.has(loop.name)) {
            yield* Effect.logDebug("Paused Loop skipped during repository polling", {
              loop: loop.name,
            });
          }
        }
        const resolved = (yield* resolveTriggerLoops(instance)).filter(
          ({ loop }) => !paused.has(loop.name),
        );
        const watched = watchedRepositories(instance, resolved);
        const settled = yield* Effect.forEach(
          watched,
          (repository) =>
            Effect.result(pollRepository(repository)).pipe(
              Effect.map((result) => ({ repository, result }) as const),
            ),
          { concurrency: REPOSITORY_CONCURRENCY },
        );

        const cycles: Array<RepositoryCycle> = [];
        const failures: Array<RepositoryPollFailure> = [];
        const backoffs: Array<Option.Option<DateTime.Utc>> = [];
        const preflightFindings: Array<LabelPreflightFinding> = [];
        for (const { repository, result } of settled) {
          if (Result.isSuccess(result)) {
            cycles.push(result.success);
            preflightFindings.push(...result.success.preflightFindings);
            continue;
          }
          const interrupted = result.failure._tag === "InterruptedRepositoryCycle";
          const error: RepositoryPollError = interrupted ? result.failure.error : result.failure;
          if (interrupted) {
            failures.push(...result.failure.failures);
            preflightFindings.push(...result.failure.preflightFindings);
            backoffs.push(result.failure.nextPollAt);
          }
          if (error._tag === "GitHubRateLimitError") {
            // A rate-limit pause is scheduling input, not a repository failure.
            yield* Effect.logWarning("GitHub rate limit reached; delaying the next cycle", {
              repository: repository.repository.name,
              operation: error.operation,
              retryAt: DateTime.formatIso(error.retryAt),
            });
            backoffs.push(Option.some(error.retryAt));
            continue;
          }
          yield* Effect.logError("Repository poll cycle failed; siblings were unaffected", {
            repository: repository.repository.name,
            ...repositoryFailureLogFields(error),
          });
          failures.push(
            new RepositoryPollFailure({
              repository: repository.repository.name,
              errorTag: error._tag,
              message: error.message,
            }),
          );
        }
        const cycle = new PollCycle({
          repositories: watched.length,
          changedItems: cycles.reduce((sum, cycle) => sum + cycle.changedItems, 0),
          submissions: cycles.flatMap(({ submissions }) => submissions),
          revokedRuns: cycles.reduce((sum, cycle) => sum + cycle.revokedRuns, 0),
          failures: [...cycles.flatMap(({ failures: isolated }) => isolated), ...failures],
          preflightFindings,
          nextPollAt: latestPollAt([...cycles.map(({ nextPollAt }) => nextPollAt), ...backoffs]),
        });
        yield* Ref.set(latest, Option.some(cycle));
        return cycle;
      }, Effect.provideContext(repositoryServices));

      // `run` never returns, so wrapping it in Effect.fn would open a span that
      // never closes; `poll` opens the span for each cycle.
      const run = (instance: LoadedInstance): Effect.Effect<never> =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const result = yield* Effect.result(poll(instance));
          if (Result.isFailure(result)) {
            const sleepMs = instance.config.settings.pollInterval * 1_000;
            yield* Effect.logError("Poll cycle could not read Loop runtime state; retrying", {
              errorTag: result.failure._tag,
              message: result.failure.message,
              operation: result.failure.operation,
              sleepMs,
            });
            yield* Effect.sleep(Duration.millis(sleepMs));
            return;
          }
          const cycle = result.success;
          const intervalAt = startedAt + instance.config.settings.pollInterval * 1_000;
          const target = Option.match(cycle.nextPollAt, {
            onNone: () => intervalAt,
            onSome: (value) => Math.max(intervalAt, DateTime.toEpochMillis(value)),
          });
          const now = yield* Clock.currentTimeMillis;
          const sleepMs = Math.max(0, target - now);
          yield* Effect.logInfo("Poll cycle complete", {
            repositories: cycle.repositories,
            changedItems: cycle.changedItems,
            submissions: cycle.submissions.length,
            revokedRuns: cycle.revokedRuns,
            failures: cycle.failures.length,
            preflightFindings: cycle.preflightFindings.length,
            sleepMs,
          });
          yield* Effect.sleep(Duration.millis(sleepMs));
        }).pipe(Effect.forever);

      return { latest: Ref.get(latest), poll, run };
    }),
  );
}
