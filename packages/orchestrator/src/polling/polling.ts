import { ChangeBus } from "@usine/core/changes";
import { CiMonitor } from "../ci.ts";
import type { DeclaredLabel } from "@usine/config/label";
import type { LoadedInstance } from "@usine/config/instance";
import type { ManagedRepo } from "@usine/config/factory";
import { ConfigParser } from "@usine/config/parser";
import { labelsForRepository, matchesLoop } from "@usine/config/project";
import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import { CursorKey, CursorStore } from "@usine/engine/cursor";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import {
  RunEngine,
  type EnginePersistenceError,
  type SubmissionResult,
} from "@usine/engine/engine";
import { ItemProjectionReader, ItemProjectionWriter } from "@usine/engine/item-projection";
import { LoopControl } from "@usine/engine/loop-control";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "@usine/engine/repository-label-projection";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import {
  BaseRefHead,
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
  Equal,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { LabelReconciler, type LabelPreflightFinding } from "../label-reconciler.ts";
import { reloadedFrom, type WatchedInstance } from "../reloads.ts";
import { type ResolvedLoop, resolveTriggerLoops } from "../trigger-submission.ts";
import {
  type InterruptedRepositoryCycle,
  latestPollAt,
  PollCycle,
  RepositoryPoll,
  type RepositoryPollError,
  RepositoryPollFailure,
  repositoryFailureLogFields,
} from "./cycle.ts";
import {
  advance,
  decisionLogFields,
  type PollFailureStreak,
  type RepositoryOutcome,
} from "./failure-streaks.ts";
import { changedItem, FailingItem, failingItemPollFailures } from "./evaluation-failures.ts";
import { closeAsksOfClosedItems } from "./closed-item-asks.ts";
import { evaluateChangedItem } from "./item-cycle.ts";
import { evaluateItem } from "./loop-evaluation.ts";
import { observeItem, synchronizeLabels } from "./repository-sync.ts";
import { acknowledgeResets, planResetRefresh } from "./reset-refresh.ts";
import { retryUnfetchedItems, UnfetchedItem } from "./unfetched-items.ts";
import { ItemHints, type ItemHint } from "./hints.ts";
import { checkOpenIssues, NO_OPEN_ISSUE_CHECK, OPEN_ISSUE_CHECK_INTERVAL } from "./open-issues.ts";
import { OpenPullRequest, openPullRequest, openPullRequestRefresh } from "./open-pull-requests.ts";

/** The number of repositories polled in parallel, kept low for GitHub's per-token limits. */
const REPOSITORY_CONCURRENCY = 4;

const ITEM_CONCURRENCY = 4;

const WatchKey = Schema.NonEmptyString.pipe(Schema.brand("GitHubPollWatchKey"));
type WatchKey = typeof WatchKey.Type;

class StoredPollCursor extends Schema.Class<StoredPollCursor>(
  "@usine/orchestrator/StoredPollCursor",
)({
  boardVersion: Schema.Literal(5),
  openPullRequests: Schema.Array(OpenPullRequest),
  // A cursor written before polling recorded base branch heads has none, so every base branch
  // counts as moved on its first poll.
  baseRefHeads: Schema.Array(BaseRefHead).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  cursor: PollCursor,
  labelEntityTag: Schema.OptionFromNullOr(EntityTag),
  watches: Schema.Array(WatchKey).check(Schema.isUnique()),
  failingItems: Schema.Array(FailingItem).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  unfetchedItems: Schema.Array(UnfetchedItem).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
}) {}

interface WatchedRepository {
  readonly repository: ManagedRepo;
  readonly declaredLabels: ReadonlyArray<DeclaredLabel>;
  readonly loops: ReadonlyArray<ResolvedLoop>;
  readonly watches: ReadonlyArray<WatchKey>;
}

/** The repositories whose recorded failing Items were fetched again for one instance. */
interface FailingItemRetries {
  readonly instance: Option.Option<LoadedInstance>;
  readonly repositories: ReadonlySet<CursorKey>;
}

type RepositoryCycle = {
  readonly changedItems: number;
  readonly submissions: ReadonlyArray<SubmissionResult>;
  readonly revokedRuns: number;
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
  readonly preflightFindings: ReadonlyArray<LabelPreflightFinding>;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
} & ({ readonly _tag: "Polled" } | { readonly _tag: "RateLimited" });

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
      ({ loop }) =>
        loop.trigger.on !== "schedule" && matchesLoop(instance.config, loop, repository),
    );
    return {
      repository,
      declaredLabels: labelsForRepository(instance.config, repository.name),
      loops,
      watches: loops.map(watchKey).sort(),
    };
  });

const sameWatches = (left: ReadonlyArray<WatchKey>, right: ReadonlyArray<WatchKey>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** The reason a wait between cycles ends. */
type PollWake =
  | { readonly _tag: "Due" }
  | { readonly _tag: "Hint"; readonly hint: ItemHint }
  | { readonly _tag: "Reloaded"; readonly instance: LoadedInstance };

/** Keeps managed repositories' Boards current and evaluates their active Loops against changed Items. */
export class PollingTriggers extends Context.Service<
  PollingTriggers,
  {
    /**
     * Polls every managed repository and evaluates its Loops against changed Items. Reports
     * repository failures without stopping the others; fails only if Loop runtime state can't be
     * read.
     */
    readonly poll: (instance: LoadedInstance) => Effect.Effect<PollCycle, EnginePersistenceError>;
    /**
     * Requests a repository or item fetch, keeping the writer's request backoff. Duplicate
     * hints coalesce, and polling repairs lost ones.
     */
    readonly hint: (
      repository: RepositoryName,
      item?: ChangedItem,
      backoffUntil?: Option.Option<DateTime.Utc>,
    ) => Effect.Effect<void>;
    /**
     * Runs cycles at the configured interval and processes self-write hints, respecting GitHub
     * request backoff. An accepted reload starts the next cycle immediately, unless GitHub asked to
     * wait longer.
     */
    readonly run: (instances: WatchedInstance) => Effect.Effect<never>;
    /**
     * The last completed cycle with its isolated failures, or `None` before the first cycle
     * completes.
     */
    readonly latest: Effect.Effect<Option.Option<PollCycle>>;
    /** The last received hint in this process, including coalesced or dropped hints. */
    readonly lastHint: Effect.Effect<Option.Option<DateTime.Utc>>;
  }
>()("@usine/orchestrator/PollingTriggers") {
  /**
   * Provides polling, hint handling, and trigger submission using the supplied GitHub and engine
   * services.
   */
  static readonly layer = Layer.effect(
    PollingTriggers,
    Effect.gen(function* () {
      const bus = yield* ChangeBus;
      const ci = yield* CiMonitor;
      const cursors = yield* CursorStore;
      const github = yield* GitHubPolling;
      const loops = yield* LoopControl;
      const latest = yield* Ref.make(Option.none<PollCycle>());
      // Kept across cycles, so a repository whose poll fails keeps its last completion time.
      const completedPolls = yield* Ref.make<ReadonlyMap<string, RepositoryPoll>>(new Map());
      const failureStreaks = yield* Ref.make<ReadonlyMap<string, PollFailureStreak>>(new Map());
      const hints = yield* ItemHints;
      const ownership = yield* Semaphore.make(1);
      // A failing Item is fetched again only on its repository's first completed cycle in a process
      // or after a reload.
      const retriedFailingItems = yield* Ref.make<FailingItemRetries>({
        instance: Option.none(),
        repositories: new Set(),
      });
      // When each repository's open issues were last successfully checked against GitHub.
      const openIssueChecks = yield* Ref.make<ReadonlyMap<CursorKey, number>>(new Map());

      const emptyCursor = (watches: ReadonlyArray<WatchKey>) =>
        StoredPollCursor.make({
          boardVersion: 5,
          openPullRequests: [],
          baseRefHeads: [],
          cursor: PollCursor.empty,
          labelEntityTag: Option.none(),
          watches,
          failingItems: [],
          unfetchedItems: [],
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

      /** Checks open issues unless the last successful check started less than 10 minutes ago. */
      const checkOpenIssuesWhenDue = Effect.fn("PollingTriggers.checkOpenIssuesWhenDue")(function* (
        watched: WatchedRepository,
      ) {
        yield* Effect.annotateCurrentSpan({ repository: watched.repository.name });
        const key = cursorKey(watched.repository);
        const now = yield* Clock.currentTimeMillis;
        const lastCheck = (yield* Ref.get(openIssueChecks)).get(key);
        if (
          lastCheck !== undefined &&
          now - lastCheck < Duration.toMillis(OPEN_ISSUE_CHECK_INTERVAL)
        ) {
          yield* Effect.logDebug("Open issues were checked less than 10 minutes ago; skipped", {
            repository: watched.repository.name,
            lastCheckedAt: DateTime.formatIso(DateTime.makeUnsafe(lastCheck)),
          });
          return NO_OPEN_ISSUE_CHECK;
        }
        const checked = yield* checkOpenIssues(watched.repository, watched.loops);
        if (checked.failures.length === 0 && Option.isNone(checked.nextPollAt)) {
          yield* Ref.update(openIssueChecks, (checks) => new Map(checks).set(key, now));
        } else {
          yield* Effect.logInfo("Open-issue check remains due for the next poll cycle", {
            repository: watched.repository.name,
            failures: checked.failures.length,
            rateLimited: Option.isSome(checked.nextPollAt),
          });
        }
        return checked;
      });

      const pollRepository = Effect.fn("PollingTriggers.pollRepository")(function* (
        watched: WatchedRepository,
      ) {
        yield* Effect.annotateCurrentSpan({ repository: watched.repository.name });
        const resetRefresh = yield* planResetRefresh(watched.repository.name);
        const stored =
          resetRefresh._tag === "FromScratch"
            ? emptyCursor(watched.watches)
            : yield* readCursor(watched);
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
          const retrying = (yield* Ref.get(retriedFailingItems)).repositories.has(
            cursorKey(watched.repository),
          )
            ? []
            : stored.failingItems;
          // Items fetched whatever detection reports: those a GitHub server error deferred in the
          // last cycle, and those a cycle-budget reset names.
          const targeted = [
            ...(yield* retryUnfetchedItems(watched.repository.name, stored.unfetchedItems)),
            ...resetRefresh.items,
          ];
          const detectedItems = detected._tag === "RepositoryChanges" ? detected.items : [];
          const detectedNumbers = new Set(detectedItems.map(({ number }) => number));
          // Mergeability changes when the base branch moves, without an updated_at or ETag change
          // on the pull request, so open pull requests stay in the cursor (ADR 0007).
          const refresh = yield* openPullRequestRefresh(
            watched.repository.name,
            stored.openPullRequests,
            stored.baseRefHeads,
            new Set([
              ...detectedNumbers,
              ...[...retrying, ...targeted].map(({ number }) => number),
            ]),
          );
          const items = new Map<number, ChangedItem>([
            ...retrying.map((failing) => [failing.number, changedItem(failing)] as const),
            ...targeted.map((item) => [item.number, item] as const),
            ...refresh.refreshed.map(
              ({ number, updatedAt }) =>
                [number, ChangedPullRequest.make({ number, updatedAt })] as const,
            ),
          ]);
          for (const item of detectedItems) items.set(item.number, item);
          if (detected._tag === "RepositoryChanges") {
            yield* Effect.logInfo("Repository changed", {
              repository: watched.repository.name,
              changedItems: detected.items.length,
              backlog: detected.backlog,
            });
          }
          // Items fetched only because the cursor or a reset kept them: refreshed open pull
          // requests, Items whose Loops failed before this process or instance, and targeted Items.
          const cursorOnly = new Set(
            [...refresh.refreshed, ...retrying, ...targeted]
              .map(({ number }) => number)
              .filter((number) => !detectedNumbers.has(number)),
          );
          if (retrying.length > 0) {
            yield* Effect.logInfo(
              "Evaluating Items whose Loops failed before this process started or the instance was reloaded",
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
            refreshedPullRequests: refresh.refreshed.length,
            items: items.size,
          });
          const recorded = new Map<number, FailingItem>(
            stored.failingItems.map((failing) => [failing.number, failing]),
          );
          const evaluations = yield* Effect.forEach(
            items.values(),
            (item) =>
              evaluateChangedItem(watched.repository, watched.loops, item, {
                recorded: Option.fromNullishOr(recorded.get(item.number)),
                cursorOnly: cursorOnly.has(item.number),
                openPullRequest: stored.openPullRequests.some(
                  ({ number }) => number === item.number,
                ),
              }),
            { concurrency: ITEM_CONCURRENCY },
          );
          const observed = evaluations.flatMap((evaluation) =>
            evaluation._tag === "Evaluated" ? [evaluation] : [],
          );
          const unfetchedItems = evaluations
            .flatMap((evaluation) =>
              evaluation._tag === "Unfetched" ? [evaluation.unfetched] : [],
            )
            .sort((left, right) => left.number - right.number);
          const unfetchedNumbers = new Set<number>(unfetchedItems.map(({ number }) => number));
          const evaluated = (number: number) => items.has(number) && !unfetchedNumbers.has(number);
          const missingRevokedRuns = evaluations.reduce(
            (sum, evaluation) => sum + (evaluation._tag === "Missing" ? evaluation.revokedRuns : 0),
            0,
          );
          const itemCycles = observed.map(({ cycle }) => cycle);
          const openIssueCheck = yield* checkOpenIssuesWhenDue(watched);
          yield* hints.defer(openIssueCheck.nextPollAt);
          // Runs after this cycle's projections and gone marks, so an Item closed now closes its Ask.
          yield* closeAsksOfClosedItems(watched.repository.name);
          // An Item the cycle did not evaluate keeps its recorded failures.
          const failingItems = [
            ...stored.failingItems.filter(({ number }) => !evaluated(number)),
            ...observed.flatMap(({ failing }) => Option.toArray(failing)),
          ].sort((left, right) => left.number - right.number);
          // An open pull request the cycle did not evaluate keeps its entry.
          const openPullRequests = [
            ...stored.openPullRequests.filter(({ number }) => !evaluated(number)),
            ...observed.flatMap(({ item, observation }) =>
              Option.toArray(openPullRequest(item, observation.snapshot)),
            ),
          ];
          const baseRefHeads = refresh.baseRefHeads.filter(({ baseRefName }) =>
            openPullRequests.some((pullRequest) =>
              Option.contains(pullRequest.baseRefName, baseRefName),
            ),
          );
          const nextCursor = StoredPollCursor.make({
            boardVersion: 5,
            cursor: detected.cursor,
            labelEntityTag: preflight.labelEntityTag,
            watches: watched.watches,
            openPullRequests,
            baseRefHeads,
            failingItems,
            unfetchedItems,
          });
          // Advancing the cursor is the commit point: every changed Item was fetched, evaluated,
          // and submitted or revoked, or kept for the next cycle after a GitHub server error. After
          // a failure, the old cursor stays so the next cycle polls again.
          if (
            detected._tag === "RepositoryChanges" ||
            items.size > 0 ||
            preflight.entityTagChanged ||
            !Equal.equals(baseRefHeads, stored.baseRefHeads)
          ) {
            yield* writeCursor(watched, nextCursor);
          }
          yield* Ref.update(retriedFailingItems, (retried) => ({
            ...retried,
            repositories: new Set([...retried.repositories, cursorKey(watched.repository)]),
          }));
          yield* acknowledgeResets(watched.repository.name, resetRefresh.resets, unfetchedItems);
          return {
            // Refreshed open PRs are observed, not reported as changed by
            // GitHub; counting them would make every idle poll look busy.
            changedItems: detected._tag === "RepositoryChanges" ? detected.items.length : 0,
            submissions: itemCycles.flatMap(({ submissions }) => submissions),
            revokedRuns: itemCycles.reduce(
              (sum, cycle) => sum + cycle.revokedRuns,
              missingRevokedRuns + openIssueCheck.revokedRuns,
            ),
            failures: [
              ...preflight.failures,
              ...openIssueCheck.failures,
              ...evaluations.flatMap((evaluation) =>
                evaluation._tag === "Unfetched" ? [evaluation.failure] : [],
              ),
              ...failingItems.flatMap((failing) =>
                failingItemPollFailures(watched.repository.name, failing),
              ),
            ],
            preflightFindings: preflight.preflightFindings,
            nextPollAt: latestPollAt([nextPollAt, openIssueCheck.nextPollAt]),
            _tag:
              Option.isSome(preflight.nextPollAt) || Option.isSome(openIssueCheck.nextPollAt)
                ? "RateLimited"
                : "Polled",
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
          ItemProjectionReader,
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
          yield* Ref.update(retriedFailingItems, (retried) =>
            Option.contains(retried.instance, instance)
              ? retried
              : { instance: Option.some(instance), repositories: new Set<CursorKey>() },
          );
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
          const ciCycle = yield* ci.reconcile(instance, Option.none());
          yield* hints.defer(ciCycle.nextPollAt);
          const watched = watchedRepositories(instance, resolved);
          const settled = yield* Effect.forEach(
            Option.isSome(ciCycle.nextPollAt) ? [] : watched,
            (repository) =>
              Effect.result(pollRepository(repository)).pipe(
                Effect.map((result) => ({ repository, result }) as const),
              ),
            { concurrency: REPOSITORY_CONCURRENCY },
          );

          const cycles: Array<RepositoryCycle> = [];
          const backoffs: Array<Option.Option<DateTime.Utc>> = [ciCycle.nextPollAt];
          const preflightFindings: Array<LabelPreflightFinding> = [];
          const completedAt = yield* DateTime.now;
          const outcomes: Array<RepositoryOutcome> = [...ciCycle.outcomes];
          if (Option.isSome(ciCycle.nextPollAt)) {
            outcomes.push(
              ...watched.map(({ repository }): RepositoryOutcome => ({
                _tag: "RateLimited",
                repository: repository.name,
                source: "Polling",
                failures: [],
              })),
            );
          }
          for (const { repository, result } of settled) {
            if (Result.isSuccess(result)) {
              outcomes.push({
                _tag: result.success._tag,
                repository: repository.repository.name,
                source: "Polling",
                failures: result.success.failures,
              });
              cycles.push(result.success);
              preflightFindings.push(...result.success.preflightFindings);
              yield* Ref.update(completedPolls, (current) =>
                new Map(current).set(
                  canonicalRepositoryName(repository.repository.name),
                  RepositoryPoll.make({ repository: repository.repository.name, completedAt }),
                ),
              );
              continue;
            }
            const interrupted = result.failure._tag === "InterruptedRepositoryCycle";
            const error: RepositoryPollError = interrupted ? result.failure.error : result.failure;
            const failures = interrupted ? result.failure.failures : [];
            if (interrupted) {
              preflightFindings.push(...result.failure.preflightFindings);
              backoffs.push(result.failure.nextPollAt);
              yield* hints.defer(result.failure.nextPollAt);
            }
            if (error._tag === "GitHubRateLimitError") {
              outcomes.push({
                _tag: "RateLimited",
                source: "Polling",
                repository: repository.repository.name,
                failures,
              });
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
            outcomes.push({
              _tag: "Failed",
              source: "Polling",
              repository: repository.repository.name,
              failures,
              failure: RepositoryPollFailure.make({
                repository: repository.repository.name,
                errorTag: error._tag,
                message: repositoryFailureLogFields(error).message,
              }),
            });
          }
          const failureStreaksState = yield* Ref.get(failureStreaks);
          const reported = advance(
            failureStreaksState,
            [
              ...watched.map(({ repository }) => repository.name),
              ...ciCycle.outcomes.map(({ repository }) => repository),
            ],
            outcomes,
          );
          yield* Ref.set(failureStreaks, reported.streaks);
          for (const decision of reported.decisions) {
            const { level, ...fields } = decisionLogFields(decision);
            yield* Effect.logWithLevel(level)("Repository poll failure streak updated", fields);
          }
          const polls = yield* Ref.get(completedPolls);
          const cycle = PollCycle.make({
            repositoryPolls: watched.flatMap(({ repository }) =>
              Option.toArray(
                Option.fromNullishOr(polls.get(canonicalRepositoryName(repository.name))),
              ),
            ),
            repositories: watched.length,
            changedItems: cycles.reduce((sum, cycle) => sum + cycle.changedItems, 0),
            submissions: cycles.flatMap(({ submissions }) => submissions),
            revokedRuns: cycles.reduce((sum, cycle) => sum + cycle.revokedRuns, 0),
            failures: reported.failures,
            preflightFindings,
            nextPollAt: latestPollAt([...cycles.map(({ nextPollAt }) => nextPollAt), ...backoffs]),
          });
          const previous = yield* Ref.getAndSet(latest, Option.some(cycle));
          yield* bus.publish(
            watched.flatMap(({ repository }) => {
              const audience = { _tag: "Repository", repository: repository.name } as const;
              const findings = (value: PollCycle | undefined) =>
                JSON.stringify([
                  (value?.failures ?? []).filter(
                    (failure) =>
                      canonicalRepositoryName(failure.repository) ===
                      canonicalRepositoryName(repository.name),
                  ),
                  (value?.preflightFindings ?? []).filter(
                    (finding) =>
                      canonicalRepositoryName(finding.repository) ===
                      canonicalRepositoryName(repository.name),
                  ),
                ]);
              const changed = findings(Option.getOrUndefined(previous)) !== findings(cycle);
              return changed
                ? [{ audience, target: { kind: "attention", id: "instance" } as const }]
                : [];
            }),
          );
          return cycle;
        },
        Effect.provideContext(repositoryServices),
        ownership.withPermits(1),
      );

      const refreshHint = Effect.fn("PollingTriggers.refreshHint")(
        function* (instance: LoadedInstance, hint: ItemHint) {
          yield* Effect.annotateCurrentSpan({
            repository: hint.repository,
            item: Option.getOrUndefined(Option.map(hint.item, (item) => item.number)),
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
            yield* Effect.logInfo("Hint ignored for an unmanaged repository", {
              repository: hint.repository,
              item: Option.getOrUndefined(Option.map(hint.item, (item) => item.number)),
            });
            return;
          }
          const ciCycle = yield* ci.reconcile(instance, Option.some(hint.repository));
          yield* hints.defer(ciCycle.nextPollAt);
          if (Option.isSome(ciCycle.nextPollAt)) return;
          if (Option.isNone(hint.item)) {
            const cycle = yield* pollRepository(watched).pipe(
              Effect.catchTag("InterruptedRepositoryCycle", (failure) =>
                hints.defer(failure.nextPollAt).pipe(Effect.andThen(Effect.fail(failure.error))),
              ),
            );
            yield* Effect.logInfo("Hint refreshed the repository", {
              repository: hint.repository,
              changedItems: cycle.changedItems,
              submissions: cycle.submissions.length,
              failures: cycle.failures,
            });
            return;
          }
          // Item hints share the normal snapshot, projection and dedup path. They never
          // advance a REST cursor or replace the latest complete cycle's findings.
          const item = hint.item.value;
          const observed = yield* observeItem(watched.repository.name, item);
          const result = yield* evaluateItem(watched.repository, watched.loops, observed);
          // The self-write changed the Item, so the next poll fetches it again
          // and records these failures for Needs you.
          for (const failure of result.failures) {
            yield* Effect.logWarning("Hint could not evaluate a Loop on the Item", {
              repository: hint.repository,
              item: item.number,
              loop: failure.loop,
              stage: failure.stage,
              errorTag: failure.errorTag,
              message: failure.message,
            });
          }
          yield* Effect.logInfo("Hint refreshed the Item", {
            repository: hint.repository,
            item: item.number,
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
                yield* Effect.logWarning("Hint refresh failed; the normal poll will retry", {
                  repository: hint.repository,
                  item: Option.getOrUndefined(Option.map(hint.item, (item) => item.number)),
                  ...repositoryFailureLogFields(error),
                });
              }),
            ),
            ownership.withPermits(1),
          ),
      );

      // An accepted reload ends the wait for `intervalAt`, never the wait for
      // `requestedAt`, the time GitHub asked for.
      const waitForNextPoll = (
        instances: WatchedInstance,
        polled: LoadedInstance,
        intervalAt: number,
        requestedAt: number,
      ) =>
        Effect.gen(function* () {
          let target = Math.max(intervalAt, requestedAt);
          let seen = polled;
          while (true) {
            const remaining = target - (yield* Clock.currentTimeMillis);
            if (remaining <= 0) return;
            const wake = yield* Effect.raceAllFirst([
              Effect.sleep(Duration.millis(remaining)).pipe(
                Effect.map((): PollWake => ({ _tag: "Due" })),
              ),
              hints.take.pipe(Effect.map((hint): PollWake => ({ _tag: "Hint", hint }))),
              reloadedFrom(instances, seen).pipe(
                Effect.map((instance): PollWake => ({ _tag: "Reloaded", instance })),
              ),
            ]);
            if (wake._tag === "Due") return;
            if (wake._tag === "Hint") {
              const currentInstance = yield* instances.get;
              yield* refreshHint(currentInstance, wake.hint);
              continue;
            }
            seen = wake.instance;
            target = requestedAt;
            const sleepMs = requestedAt - (yield* Clock.currentTimeMillis);
            if (sleepMs > 0) {
              yield* Effect.logInfo(
                "Instance reloaded; the next poll waits for the time GitHub asked for",
                { sleepMs },
              );
            } else {
              yield* Effect.logInfo(
                "Instance reloaded; polling now instead of after poll_interval",
              );
            }
          }
        });

      // `run` never returns, so wrapping it in Effect.fn would open a span that
      // never closes; `poll` opens the span for each cycle.
      const run = (instances: WatchedInstance): Effect.Effect<never> =>
        Effect.gen(function* () {
          const instance = yield* instances.get;
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
          const requestedAt = Option.match(cycle.nextPollAt, {
            onNone: () => 0,
            onSome: DateTime.toEpochMillis,
          });
          const now = yield* Clock.currentTimeMillis;
          const sleepMs = Math.max(0, Math.max(intervalAt, requestedAt) - now);
          yield* Effect.logInfo("Poll cycle complete", {
            repositories: cycle.repositories,
            changedItems: cycle.changedItems,
            submissions: cycle.submissions.length,
            revokedRuns: cycle.revokedRuns,
            failures: cycle.failures.length,
            preflightFindings: cycle.preflightFindings.length,
            sleepMs,
          });
          yield* waitForNextPoll(instances, instance, intervalAt, requestedAt);
        }).pipe(Effect.forever);

      return { latest: Ref.get(latest), poll, run, hint: hints.offer, lastHint: hints.lastHint };
    }),
  ).pipe(Layer.provide(ItemHints.layer));
}
