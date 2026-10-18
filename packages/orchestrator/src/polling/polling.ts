import type { DeclaredLabel } from "@usine/config/label";
import type { LoadedInstance } from "@usine/config/instance";
import type { ManagedRepo } from "@usine/config/factory";
import { ConfigParser } from "@usine/config/parser";
import { matchesSelector } from "@usine/config/selector";
import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
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
import {
  ChangedPullRequest,
  type ChangedItem,
  EntityTag,
  PollCursor,
  GitHubPolling,
} from "@usine/github/polling";
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
  Semaphore,
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
import {
  changedItem,
  FailingItem,
  failingItem,
  failingItemPollFailures,
  logItemEvaluation,
} from "./evaluation-failures.ts";
import { evaluateItem, revokeMissingItem } from "./loop-evaluation.ts";
import { observeItem, synchronizeLabels } from "./repository-sync.ts";
import { ItemHints, type ItemHint } from "./hints.ts";

/** GitHub tolerates a handful of parallel REST and GraphQL calls per token. */
const REPOSITORY_CONCURRENCY = 4;

const ITEM_CONCURRENCY = 4;

const WatchKey = Schema.NonEmptyString.pipe(Schema.brand("GitHubPollWatchKey"));
type WatchKey = typeof WatchKey.Type;

class StoredPollCursor extends Schema.Class<StoredPollCursor>(
  "@usine/orchestrator/StoredPollCursor",
)({
  boardVersion: Schema.Literal(5),
  openPullRequests: Schema.Array(
    Schema.Struct({
      number: ChangedPullRequest.fields.number,
      updatedAt: Schema.DateTimeUtcFromString,
    }),
  ),
  cursor: PollCursor,
  labelEntityTag: Schema.OptionFromNullOr(EntityTag),
  watches: Schema.Array(WatchKey).check(Schema.isUnique()),
  failingItems: Schema.Array(FailingItem).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
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
     * before its Run decisions. Known open pull requests are fetched again every
     * cycle, changed or not, so mergeability that moves without an Item update
     * still reaches the Board and Loops; `changedItems` counts detection only.
     * A repository commits its cursor only after all Items finish. A Loop
     * whose `if:` or prompt fails on an Item is logged once per content hash
     * and reported in every cycle while it keeps failing; the Item's other
     * Loops and the repository's other Items continue. An open pull request
     * or failing Item that only the cursor kept and that GitHub no longer has
     * is dropped from the cursor with a warning, and its unstarted Runs are
     * revoked. Repository failures are reported while siblings continue;
     * failure to read Loop runtime state fails the whole cycle.
     */
    readonly poll: (instance: LoadedInstance) => Effect.Effect<PollCycle, EnginePersistenceError>;
    /** Nudges an authoritative Item fetch after a self-write, retaining any request backoff from the writer. Pending duplicates coalesce; polling repairs loss. */
    readonly hint: (
      repository: RepositoryName,
      item: ChangedItem,
      backoffUntil?: Option.Option<DateTime.Utc>,
    ) => Effect.Effect<void>;
    /** Repeats cycles at the configured interval and processes self-write Hints, respecting GitHub request backoff. */
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
      const hints = yield* ItemHints;
      const ownership = yield* Semaphore.make(1);
      // Loops are fixed for the life of the process, so a failing Item is
      // fetched again only on its repository's first completed cycle.
      const retriedFailingItems = yield* Ref.make<ReadonlySet<CursorKey>>(new Set());

      const emptyCursor = (watches: ReadonlyArray<WatchKey>) =>
        new StoredPollCursor({
          boardVersion: 5,
          openPullRequests: [],
          cursor: PollCursor.empty,
          labelEntityTag: Option.none(),
          watches,
          failingItems: [],
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
        yield* hints.defer(preflight.nextPollAt);
        return yield* Effect.gen(function* () {
          // Label creation finishes before change detection and Item evaluation
          // begin, including on the first cycle after `usine up`.
          const detected = yield* github.changes(watched.repository.name, stored.cursor);
          yield* hints.defer(detected.backoffUntil);
          const retrying = (yield* Ref.get(retriedFailingItems)).has(cursorKey(watched.repository))
            ? []
            : stored.failingItems;
          // Mergeability can change without an issue updated_at/ETag change
          // (base moves and lazy UNKNOWN computation). Keep all observed open
          // PRs in the durable cursor and refresh them on every poll, even 304s.
          // Version 5 rebuilds this set by replaying detection on upgrade.
          const items = new Map<number, ChangedItem>([
            ...retrying.map((failing) => [failing.number, changedItem(failing)] as const),
            ...stored.openPullRequests.map(
              (item) => [item.number, new ChangedPullRequest(item)] as const,
            ),
          ]);
          if (detected._tag === "RepositoryChanges") {
            for (const item of detected.items) items.set(item.number, item);
            yield* Effect.logInfo("Repository changed", {
              repository: watched.repository.name,
              changedItems: detected.items.length,
              backlog: detected.backlog,
            });
          }
          const detectedNumbers = new Set(
            (detected._tag === "RepositoryChanges" ? detected.items : []).map(
              ({ number }) => number,
            ),
          );
          // Fetched only because the cursor kept them: the open pull requests
          // it refreshes and the Items whose Loops failed before this process.
          const cursorOnly = new Set(
            [...stored.openPullRequests, ...retrying]
              .map(({ number }) => number)
              .filter((number) => !detectedNumbers.has(number)),
          );
          if (retrying.length > 0) {
            yield* Effect.logInfo(
              "Evaluating Items whose Loops failed before this process started",
              {
                repository: watched.repository.name,
                items: retrying.map(({ number }) => number).join(", "),
              },
            );
          }
          const nextPollAt = latestPollAt([detected.nextPollAt, preflight.nextPollAt]);
          yield* Effect.logDebug("Refreshing detected Items and open pull requests", {
            repository: watched.repository.name,
            detection: detected._tag,
            openPullRequests: stored.openPullRequests.length,
            items: items.size,
          });
          const recorded = new Map<number, FailingItem>(
            stored.failingItems.map((failing) => [failing.number, failing]),
          );
          const evaluations = yield* Effect.forEach(
            items.values(),
            (item) =>
              Effect.gen(function* () {
                const observation = yield* observeItem(watched.repository.name, item);
                const cycle = yield* evaluateItem(watched.repository, watched.loops, observation);
                const failing = failingItem(
                  item,
                  observation.projection.contentHash,
                  cycle.failures,
                );
                yield* logItemEvaluation(
                  watched.repository.name,
                  item.number,
                  Option.fromNullishOr(recorded.get(item.number)),
                  failing,
                );
                return { _tag: "Evaluated", item, observation, cycle, failing } as const;
              }).pipe(
                // An Item the cursor kept may have been deleted or transferred
                // since; it must not stall the repository. A detected Item, a
                // transient request failure, or any other invalid response
                // still interrupts the cycle, which retries it next time.
                Effect.catchTag("GitHubItemNotFoundError", (error) =>
                  Effect.gen(function* () {
                    if (!cursorOnly.has(item.number)) return yield* error;
                    const revokedRuns = yield* revokeMissingItem(
                      watched.repository,
                      watched.loops,
                      item,
                    );
                    yield* Effect.logWarning(
                      "GitHub no longer has an Item the poll cursor kept; it is dropped from the cursor",
                      {
                        repository: watched.repository.name,
                        item: item.number,
                        openPullRequest: stored.openPullRequests.some(
                          ({ number }) => number === item.number,
                        ),
                        revokedRuns,
                        errorTag: error._tag,
                        message: error.message,
                      },
                    );
                    return { _tag: "Missing", revokedRuns } as const;
                  }),
                ),
              ),
            { concurrency: ITEM_CONCURRENCY },
          );
          const observed = evaluations.flatMap((evaluation) =>
            evaluation._tag === "Evaluated" ? [evaluation] : [],
          );
          const missingRevokedRuns = evaluations.reduce(
            (sum, evaluation) => sum + (evaluation._tag === "Missing" ? evaluation.revokedRuns : 0),
            0,
          );
          const itemCycles = observed.map(({ cycle }) => cycle);
          // An Item the cycle did not fetch keeps its recorded failures.
          const failingItems = [
            ...stored.failingItems.filter(({ number }) => !items.has(number)),
            ...observed.flatMap(({ failing }) => Option.toArray(failing)),
          ].sort((left, right) => left.number - right.number);
          const nextCursor = new StoredPollCursor({
            boardVersion: 5,
            cursor: detected.cursor,
            labelEntityTag: preflight.labelEntityTag,
            watches: watched.watches,
            openPullRequests: observed.flatMap(({ item, observation }) =>
              item._tag === "ChangedPullRequest" && observation.projection.payload.state === "OPEN"
                ? [{ number: item.number, updatedAt: item.updatedAt }]
                : [],
            ),
            failingItems,
          });
          // Advancing the cursor is the commit point: every changed item was
          // fetched, evaluated, and submitted or revoked. After a failure the
          // old cursor stays so the next cycle re-polls.
          if (
            detected._tag === "RepositoryChanges" ||
            items.size > 0 ||
            preflight.entityTagChanged
          ) {
            yield* writeCursor(watched, nextCursor);
          }
          yield* Ref.update(
            retriedFailingItems,
            (keys) => new Set([...keys, cursorKey(watched.repository)]),
          );
          yield* Effect.forEach(resets, budgets.acknowledgeReset, { discard: true });
          return {
            // Refreshed open PRs are observed, not reported as changed by
            // GitHub; counting them would make every idle poll look busy.
            changedItems: detected._tag === "RepositoryChanges" ? detected.items.length : 0,
            submissions: itemCycles.flatMap(({ submissions }) => submissions),
            revokedRuns: itemCycles.reduce(
              (sum, cycle) => sum + cycle.revokedRuns,
              missingRevokedRuns,
            ),
            failures: [
              ...preflight.failures,
              ...failingItems.flatMap((failing) =>
                failingItemPollFailures(watched.repository.name, failing),
              ),
            ],
            preflightFindings: preflight.preflightFindings,
            nextPollAt,
          } satisfies RepositoryCycle;
        }).pipe(
          Effect.mapError((error): InterruptedRepositoryCycle => ({
            _tag: "InterruptedRepositoryCycle",
            error,
            failures: [
              ...preflight.failures,
              ...stored.failingItems.flatMap((failing) =>
                failingItemPollFailures(watched.repository.name, failing),
              ),
            ],
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

      const poll = Effect.fn("PollingTriggers.poll")(
        function* (instance: LoadedInstance) {
          yield* hints.awaitBackoff;
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
              yield* hints.defer(result.failure.nextPollAt);
            }
            if (error._tag === "GitHubRateLimitError") {
              // A rate-limit pause is scheduling input, not a repository failure.
              yield* Effect.logWarning("GitHub rate limit reached; delaying the next cycle", {
                repository: repository.repository.name,
                operation: error.operation,
                retryAt: DateTime.formatIso(error.retryAt),
              });
              backoffs.push(Option.some(error.retryAt));
              yield* hints.defer(Option.some(error.retryAt));
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
        },
        Effect.provideContext(repositoryServices),
        ownership.withPermits(1),
      );

      const refreshHint = Effect.fn("PollingTriggers.refreshHint")(
        function* (instance: LoadedInstance, hint: ItemHint) {
          yield* Effect.annotateCurrentSpan({
            repository: hint.repository,
            item: hint.item.number,
          });
          yield* hints.awaitBackoff;
          const paused = new Set(
            (yield* loops.states).filter((state) => state.paused).map((state) => state.loop),
          );
          const resolved = (yield* resolveTriggerLoops(instance)).filter(
            ({ loop }) => !paused.has(loop.name),
          );
          const watched = watchedRepositories(instance, resolved).find(
            ({ repository }) =>
              canonicalRepositoryName(repository.name) === canonicalRepositoryName(hint.repository),
          );
          if (watched === undefined) {
            yield* Effect.logInfo("Self-write Hint ignored for an unmanaged repository", {
              repository: hint.repository,
              item: hint.item.number,
            });
            return;
          }
          // Share the normal snapshot, projection and dedup path. Hints never
          // advance a REST cursor or replace the latest complete cycle's findings.
          const observed = yield* observeItem(watched.repository.name, hint.item);
          const result = yield* evaluateItem(watched.repository, watched.loops, observed);
          // The self-write changed the Item, so the next poll fetches it again
          // and records these failures for Needs you.
          for (const failure of result.failures) {
            yield* Effect.logWarning("Self-write Hint could not evaluate a Loop on the Item", {
              repository: hint.repository,
              item: hint.item.number,
              loop: failure.loop,
              stage: failure.stage,
              errorTag: failure.errorTag,
              message: failure.message,
            });
          }
          yield* Effect.logInfo("Self-write Hint refreshed the Item", {
            repository: hint.repository,
            item: hint.item.number,
            submissions: result.submissions.length,
            revokedRuns: result.revokedRuns,
            failures: result.failures.length,
          });
        },
        Effect.provideContext(repositoryServices),
        (effect, _instance, hint) =>
          effect.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (error._tag === "GitHubRateLimitError")
                  yield* hints.defer(Option.some(error.retryAt));
                yield* Effect.logWarning(
                  "Self-write Hint refresh failed; the normal poll will retry",
                  {
                    repository: hint.repository,
                    item: hint.item.number,
                    ...repositoryFailureLogFields(error),
                  },
                );
              }),
            ),
            ownership.withPermits(1),
          ),
      );

      const waitForNextPoll = (instance: LoadedInstance, target: number) =>
        Effect.gen(function* () {
          while (true) {
            const remaining = target - (yield* Clock.currentTimeMillis);
            if (remaining <= 0) return;
            const hint = yield* Effect.raceFirst(
              hints.take.pipe(Effect.map(Option.some)),
              Effect.sleep(Duration.millis(remaining)).pipe(Effect.as(Option.none<ItemHint>())),
            );
            if (Option.isNone(hint)) return;
            yield* refreshHint(instance, hint.value);
          }
        });

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
          yield* waitForNextPoll(instance, target);
        }).pipe(Effect.forever);

      return { latest: Ref.get(latest), poll, run, hint: hints.offer };
    }),
  ).pipe(Layer.provide(ItemHints.layer));
}
