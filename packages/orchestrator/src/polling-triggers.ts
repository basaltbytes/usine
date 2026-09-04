import {
  ConfigParser,
  environmentFor,
  type ConfigFileError,
  type LoadedInstance,
  type LoopFile,
  type ManagedRepo,
  matchesSelector,
  repositoryContext,
} from "@usine/config";
import { AttemptChannel, Event, Item, Repository } from "@usine/core";
import {
  CursorKey,
  CursorStore,
  type EnginePersistenceError,
  ItemContentHash,
  ItemNumber,
  ItemProjection,
  ItemProjectionSource,
  ItemProjectionWriter,
  LoopControl,
  RepositoryLabel,
  RepositoryLabelProjection,
  RepositoryLabelProjectionWriter,
  RunEngine,
  SubmissionResult,
  type RunEngineError,
} from "@usine/engine";
import { ExpressionEngine, type ExpressionError } from "@usine/expression";
import {
  GitHubPolling,
  EntityTag,
  PollCursor,
  RepositoryLabelCatalog,
  type ChangedItem,
  type GitHubAppError,
  type PayloadSnapshot,
  type RepositoryLabelDetection,
} from "@usine/github";
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
import {
  configFileErrorLogFields,
  type ResolvedLoop,
  resolveTriggerLoops,
  submissionLogFields,
  triggerSubmission,
} from "./trigger-submission.ts";

/** GitHub REST + GraphQL tolerate a handful of parallel calls per token. */
const REPOSITORY_CONCURRENCY = 4;

const ITEM_CONCURRENCY = 4;

const WatchKey = Schema.NonEmptyString.pipe(Schema.brand("GitHubPollWatchKey"));
type WatchKey = typeof WatchKey.Type;

/**
 * The ItemKey of one GitHub issue or pull request: the repository's canonical
 * name and the item number, JSON-encoded. The poll encodes with this schema and
 * the web decodes with it to link a Run back to its Item, so the two cannot
 * drift apart. Schedule Runs key the repository alone (see schedule-triggers)
 * and therefore do not decode as an item.
 *
 * `toType` keeps the ItemKey brand on the encoded side, so `encodeSync`
 * returns an `Item.ItemKey` rather than a bare string.
 */
export const GitHubItemKey = Schema.toType(Item.ItemKey).pipe(
  Schema.decodeTo(
    Schema.fromJsonString(Schema.Tuple([Schema.Literal("github"), Repository.Name, Item.Number])),
  ),
);
const encodeGitHubItemKey = Schema.encodeSync(GitHubItemKey);

class StoredPollCursor extends Schema.Class<StoredPollCursor>(
  "@usine/orchestrator/StoredPollCursor",
)({
  boardVersion: Schema.Literal(3),
  cursor: PollCursor,
  labelEntityTag: Schema.OptionFromNullOr(EntityTag),
  watches: Schema.Array(WatchKey).check(Schema.isUnique()),
}) {}

/** One repository whose cycle ended in a typed error; siblings were unaffected. */
export class RepositoryPollFailure extends Schema.Class<RepositoryPollFailure>(
  "@usine/orchestrator/RepositoryPollFailure",
)({
  repository: Repository.Name,
  errorTag: Schema.NonEmptyString,
  message: Schema.String,
}) {}

export class PollCycle extends Schema.Class<PollCycle>("@usine/orchestrator/PollCycle")({
  repositories: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  changedItems: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  submissions: Schema.Array(SubmissionResult),
  /** Run ids actually revoked because their item stopped matching. */
  revokedRuns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failures: Schema.Array(RepositoryPollFailure),
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
}) {}

type RepositoryPollError = ConfigFileError | ExpressionError | GitHubAppError | RunEngineError;

const repositoryFailureLogFields = (error: RepositoryPollError) => {
  const common = { errorTag: error._tag, message: error.message };
  if (error._tag === "ConfigFileError") {
    return { ...common, ...configFileErrorLogFields(error) };
  }
  if (error._tag === "ExpressionCheckError" || error._tag === "ExpressionEvaluationError") {
    return { ...common, expression: error.source };
  }
  return common;
};

interface WatchedRepository {
  readonly repository: ManagedRepo;
  readonly loops: ReadonlyArray<ResolvedLoop>;
  readonly watches: ReadonlyArray<WatchKey>;
}

interface RepositoryCycle {
  readonly changedItems: number;
  readonly submissions: ReadonlyArray<SubmissionResult>;
  readonly revokedRuns: number;
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

interface ItemCycle {
  readonly submissions: ReadonlyArray<SubmissionResult>;
  readonly revokedRuns: number;
  /** Loop-authoring failures isolated to their loop so the cursor still advances. */
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
}

/** What one repository's label-catalog request contributed to its cycle. */
interface LabelCatalogCycle {
  readonly labelEntityTag: Option.Option<EntityTag>;
  /** A fresh catalog was stored; its ETag must persist even when no item changed. */
  readonly stored: boolean;
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

const cursorKey = (repository: ManagedRepo): CursorKey =>
  CursorKey.make(`github-poll:${Repository.canonical(repository.name)}`);

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
    return { repository, loops, watches: loops.map(watchKey).sort() };
  });

const sameWatches = (left: ReadonlyArray<WatchKey>, right: ReadonlyArray<WatchKey>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const itemStream = (item: ChangedItem): "issue" | "pr" =>
  item._tag === "ChangedIssue" ? "issue" : "pr";

const itemKey = (repository: ManagedRepo, item: ChangedItem): Item.ItemKey =>
  encodeGitHubItemKey([
    "github",
    Repository.Name.make(Repository.canonical(repository.name)),
    ItemNumber.make(item.number),
  ]);

const eventKey = (
  loop: LoopFile,
  repository: ManagedRepo,
  item: ChangedItem,
  snapshot: PayloadSnapshot,
): Event.DedupKey =>
  Event.DedupKey.make(
    JSON.stringify([
      loop.name,
      Repository.canonical(repository.name),
      item.number,
      snapshot.contentHash,
    ]),
  );

const latestPollAt = (
  values: ReadonlyArray<Option.Option<DateTime.Utc>>,
): Option.Option<DateTime.Utc> => {
  const epochs = values.flatMap((value) =>
    Option.match(value, {
      onNone: () => [],
      onSome: (dateTime) => [DateTime.toEpochMillis(dateTime)],
    }),
  );
  return epochs.length === 0 ? Option.none() : DateTime.make(Math.max(...epochs));
};

/** Full selector-pruned GitHub change → snapshot → CEL → Event composition. */
export class PollingTriggers extends Context.Service<
  PollingTriggers,
  {
    /**
     * One cycle over every watched repository. Per-repository failures are
     * isolated, logged, and reported on the cycle — one bad repository never
     * stops its siblings, and only a defect stops the loop.
     */
    readonly poll: (instance: LoadedInstance) => Effect.Effect<PollCycle, EnginePersistenceError>;
    readonly run: (instance: LoadedInstance) => Effect.Effect<never>;
    readonly latest: Effect.Effect<Option.Option<PollCycle>>;
  }
>()("@usine/orchestrator/PollingTriggers") {
  static readonly layer = Layer.effect(
    PollingTriggers,
    Effect.gen(function* () {
      const cursors = yield* CursorStore;
      const config = yield* ConfigParser;
      const expressions = yield* ExpressionEngine;
      const github = yield* GitHubPolling;
      const items = yield* ItemProjectionWriter;
      const repositoryLabels = yield* RepositoryLabelProjectionWriter;
      const runs = yield* RunEngine;
      const loops = yield* LoopControl;
      const latest = yield* Ref.make(Option.none<PollCycle>());

      const emptyCursor = (watches: ReadonlyArray<WatchKey>) =>
        new StoredPollCursor({
          boardVersion: 3,
          cursor: PollCursor.empty,
          labelEntityTag: Option.none(),
          watches,
        });

      const readCursor = Effect.fn("PollingTriggers.readCursor")(function* (
        watched: WatchedRepository,
      ) {
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

      const writeCursor = Effect.fn("PollingTriggers.writeCursor")(
        (watched: WatchedRepository, cursor: StoredPollCursor) =>
          cursors.write(cursorKey(watched.repository), StoredPollCursor, cursor),
      );

      const evaluateItem = Effect.fn("PollingTriggers.evaluateItem")(function* (
        watched: WatchedRepository,
        item: ChangedItem,
      ) {
        yield* Effect.annotateCurrentSpan({
          repository: watched.repository.name,
          item: item.number,
        });
        const loops = watched.loops.filter(({ loop }) => loop.trigger.on === itemStream(item));
        const snapshot = yield* github.snapshot(watched.repository.name, item);
        // Both snapshot variants carry their payload; the union needs no recheck.
        const payload: Schema.JsonObject = snapshot.payload;
        const context = { repo: repositoryContext(watched.repository), item: payload };
        const stableItemKey = itemKey(watched.repository, item);
        yield* items.upsert(
          new ItemProjection({
            itemKey: stableItemKey,
            repository: watched.repository.name,
            source: ItemProjectionSource.make(itemStream(item)),
            number: ItemNumber.make(item.number),
            contentHash: ItemContentHash.make(snapshot.contentHash),
            payload,
          }),
        );
        yield* Effect.logDebug("Fetched changed-item snapshot", {
          repository: watched.repository.name,
          item: item.number,
          stream: itemStream(item),
          contentHash: snapshot.contentHash,
        });
        if (loops.length === 0) {
          yield* Effect.logDebug("Item projected without any matching repository Loop", {
            repository: watched.repository.name,
            item: item.number,
            stream: itemStream(item),
          });
          return { submissions: [], revokedRuns: 0, failures: [] } satisfies ItemCycle;
        }
        const submissions: Array<SubmissionResult> = [];
        const failures: Array<RepositoryPollFailure> = [];
        let revokedRuns = 0;
        for (const { agent, loop, parentModel } of loops) {
          yield* Effect.annotateCurrentSpan({ loop: loop.name, agent: agent.name });
          const matches = yield* expressions.evaluateBoolean(
            loop.trigger.if,
            environmentFor(loop.trigger.on),
            context,
          );
          if (!matches) {
            yield* Effect.logDebug("Item did not match its loop expression", {
              repository: watched.repository.name,
              loop: loop.name,
              agent: agent.name,
              item: item.number,
            });
            const revoked = yield* runs.revoke(loop.name, stableItemKey);
            revokedRuns += revoked.length;
            if (revoked.length > 0) {
              yield* Effect.logInfo("Item stopped matching; revoked its unstarted runs", {
                repository: watched.repository.name,
                loop: loop.name,
                agent: agent.name,
                item: item.number,
                runIds: revoked.join(", "),
              });
            }
            continue;
          }

          const dedupKey = eventKey(loop, watched.repository, item, snapshot);
          const receivedAt = yield* DateTime.now;
          // A render failure is deterministic loop authoring, not transport:
          // re-polling the same snapshot re-fails identically. Isolate it to
          // this loop so sibling loops and the cursor still advance.
          const rendered = yield* Effect.result(config.renderPrompt(loop, context));
          if (Result.isFailure(rendered)) {
            yield* Effect.logError("Loop prompt rendering failed; sibling loops were unaffected", {
              loop: loop.name,
              repository: watched.repository.name,
              agent: agent.name,
              item: item.number,
              errorTag: rendered.failure._tag,
              message: rendered.failure.message,
              ...configFileErrorLogFields(rendered.failure),
            });
            failures.push(
              new RepositoryPollFailure({
                repository: watched.repository.name,
                errorTag: rendered.failure._tag,
                message: rendered.failure.message,
              }),
            );
            continue;
          }
          const submitted = yield* runs.submit(
            triggerSubmission({
              dedupKey,
              itemKey: stableItemKey,
              loop,
              payload,
              receivedAt,
              repository: watched.repository,
              task: AttemptChannel.Task.make(rendered.success),
              agent,
              parentModel,
            }),
          );
          yield* Effect.logInfo("Submitted matching item state", {
            repository: watched.repository.name,
            loop: loop.name,
            agent: agent.name,
            item: item.number,
            contentHash: snapshot.contentHash,
            result: submitted._tag,
            ...submissionLogFields(submitted),
          });
          submissions.push(submitted);
        }
        return { submissions, revokedRuns, failures } satisfies ItemCycle;
      });

      /**
       * The label catalog feeds the Board projection only. A failed catalog
       * request keeps the stored catalog and ETag and never blocks trigger
       * evaluation: label-triggered Loops fire from the change poll alone.
       */
      const applyLabelCatalog = Effect.fn("PollingTriggers.applyLabelCatalog")(function* (
        watched: WatchedRepository,
        stored: StoredPollCursor,
        result: Result.Result<RepositoryLabelDetection, GitHubAppError>,
      ) {
        const unchanged = {
          labelEntityTag: stored.labelEntityTag,
          stored: false,
          failures: [],
          nextPollAt: Option.none(),
        } satisfies LabelCatalogCycle;
        if (Result.isFailure(result)) {
          const error = result.failure;
          if (error._tag === "GitHubRateLimitError") {
            yield* Effect.logWarning("Label catalog rate-limited; keeping the stored catalog", {
              repository: watched.repository.name,
              operation: error.operation,
              retryAt: DateTime.formatIso(error.retryAt),
            });
            return { ...unchanged, nextPollAt: Option.some(error.retryAt) };
          }
          yield* Effect.logError(
            "Label catalog request failed; kept the stored catalog and evaluated items anyway",
            {
              repository: watched.repository.name,
              ...repositoryFailureLogFields(error),
            },
          );
          return {
            ...unchanged,
            failures: [
              new RepositoryPollFailure({
                repository: watched.repository.name,
                errorTag: error._tag,
                message: error.message,
              }),
            ],
          };
        }
        const detection = result.success;
        if (!(detection instanceof RepositoryLabelCatalog)) {
          yield* Effect.logDebug("Repository label catalog unchanged (304)", {
            repository: watched.repository.name,
          });
          return unchanged;
        }
        yield* repositoryLabels.replace(
          new RepositoryLabelProjection({
            repository: watched.repository.name,
            labels: detection.labels.map(
              ({ name, color, description }) =>
                new RepositoryLabel({ name, color: Option.some(color), description }),
            ),
          }),
        );
        return { ...unchanged, labelEntityTag: detection.entityTag, stored: true };
      });

      const pollRepository = Effect.fn("PollingTriggers.pollRepository")(function* (
        watched: WatchedRepository,
      ) {
        yield* Effect.annotateCurrentSpan({ repository: watched.repository.name });
        const stored = yield* readCursor(watched);
        const [detected, labelResult] = yield* Effect.all(
          [
            github.changes(watched.repository.name, stored.cursor),
            Effect.result(github.labels(watched.repository.name, stored.labelEntityTag)),
          ] as const,
          { concurrency: "unbounded" },
        );
        const catalog = yield* applyLabelCatalog(watched, stored, labelResult);
        const nextCursor = new StoredPollCursor({
          boardVersion: 3,
          cursor: detected.cursor,
          labelEntityTag: catalog.labelEntityTag,
          watches: watched.watches,
        });
        const nextPollAt = latestPollAt([detected.nextPollAt, catalog.nextPollAt]);
        if (detected._tag === "RepositoryNotModified") {
          if (catalog.stored) {
            yield* writeCursor(watched, nextCursor);
          }
          yield* Effect.logDebug("Repository unchanged (304)", {
            repository: watched.repository.name,
          });
          return {
            changedItems: 0,
            submissions: [],
            revokedRuns: 0,
            failures: catalog.failures,
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
          (item) => evaluateItem(watched, item),
          { concurrency: ITEM_CONCURRENCY },
        );
        // Advancing is the commit point: every changed item was fetched,
        // evaluated, and submitted/revoked successfully. A prior failure
        // leaves the old cursor so the next cycle safely re-polls.
        yield* writeCursor(watched, nextCursor);
        return {
          changedItems: detected.items.length,
          submissions: itemCycles.flatMap(({ submissions }) => submissions),
          revokedRuns: itemCycles.reduce((sum, cycle) => sum + cycle.revokedRuns, 0),
          failures: [...catalog.failures, ...itemCycles.flatMap(({ failures }) => failures)],
          nextPollAt,
        } satisfies RepositoryCycle;
      });

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
        for (const { repository, result } of settled) {
          if (Result.isSuccess(result)) {
            cycles.push(result.success);
            continue;
          }
          const error: RepositoryPollError = result.failure;
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
          nextPollAt: latestPollAt([...cycles.map(({ nextPollAt }) => nextPollAt), ...backoffs]),
        });
        yield* Ref.set(latest, Option.some(cycle));
        return cycle;
      });

      // No Effect.fn here: `run` never returns, so a named wrapper would open
      // a span that never closes. Each cycle's span lives on `poll`.
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
            sleepMs,
          });
          yield* Effect.sleep(Duration.millis(sleepMs));
        }).pipe(Effect.forever);

      return { latest: Ref.get(latest), poll, run };
    }),
  );
}
