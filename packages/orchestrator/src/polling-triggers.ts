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
import { Agent, AttemptChannel, Event, Item, Repository } from "@usine/core";
import {
  CursorKey,
  CursorStore,
  RunEngine,
  SubmissionResult,
  type RunEngineError,
} from "@usine/engine";
import { ExpressionEngine, type ExpressionError } from "@usine/expression";
import {
  GitHubPolling,
  PollCursor,
  type ChangedItem,
  type GitHubAppError,
  type PayloadSnapshot,
} from "@usine/github";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Result, Schema } from "effect";
import { submissionLogFields, triggerSubmission } from "./trigger-submission.ts";

/** GitHub REST + GraphQL tolerate a handful of parallel calls per token. */
const REPOSITORY_CONCURRENCY = 4;

const ITEM_CONCURRENCY = 4;

const WatchKey = Schema.NonEmptyString.pipe(Schema.brand("GitHubPollWatchKey"));
type WatchKey = typeof WatchKey.Type;

class StoredPollCursor extends Schema.Class<StoredPollCursor>(
  "@usine/orchestrator/StoredPollCursor",
)({
  cursor: PollCursor,
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

interface WatchedRepository {
  readonly repository: ManagedRepo;
  readonly loops: ReadonlyArray<WatchedLoop>;
  readonly watches: ReadonlyArray<WatchKey>;
}

interface WatchedLoop {
  readonly loop: LoopFile;
  readonly agent: Agent.Agent;
  readonly parentModel: Option.Option<Agent.ModelId>;
}

interface RepositoryCycle {
  readonly changedItems: number;
  readonly submissions: ReadonlyArray<SubmissionResult>;
  readonly revokedRuns: number;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

interface ItemCycle {
  readonly submissions: ReadonlyArray<SubmissionResult>;
  readonly revokedRuns: number;
}

const cursorKey = (repository: ManagedRepo): CursorKey =>
  CursorKey.make(`github-poll:${Repository.canonical(repository.name)}`);

const watchKey = ({ loop }: WatchedLoop): WatchKey =>
  WatchKey.make(JSON.stringify([loop.name, loop.trigger.on, loop.trigger.if]));

const watchedRepositories = Effect.fn("PollingTriggers.watchedRepositories")(function* (
  instance: LoadedInstance,
) {
  const roster = new Map(instance.agents.map((agent) => [agent.name, agent]));
  const resolved = yield* Effect.forEach(instance.loops, (loop) =>
    Effect.gen(function* () {
      const loaded = roster.get(loop.agent);
      if (loaded === undefined) {
        return yield* Effect.die(
          new Error(`Loaded loop ${loop.name} has no rostered Agent ${loop.agent}`),
        );
      }
      const agent = new Agent.Agent({
        name: loaded.name,
        harness: loaded.harness,
        model: loaded.model,
        effort: loaded.effort,
        parentModel: loaded.parentModel,
        persona: loaded.persona,
      });
      return {
        loop,
        agent,
        parentModel: Agent.resolveParentModel(agent, instance.config.settings.parentModel),
      } satisfies WatchedLoop;
    }),
  );
  return instance.config.repos.flatMap((repository) => {
    const loops = resolved.filter(
      ({ loop }) => loop.trigger.on !== "schedule" && matchesSelector(loop.selector, repository),
    );
    return loops.length === 0 ? [] : [{ repository, loops, watches: loops.map(watchKey).sort() }];
  });
});

const sameWatches = (left: ReadonlyArray<WatchKey>, right: ReadonlyArray<WatchKey>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const itemStream = (item: ChangedItem): "issue" | "pr" =>
  item._tag === "ChangedIssue" ? "issue" : "pr";

const itemKey = (repository: ManagedRepo, item: ChangedItem): Item.ItemKey =>
  Item.ItemKey.make(JSON.stringify(["github", Repository.canonical(repository.name), item.number]));

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
    readonly poll: (instance: LoadedInstance) => Effect.Effect<PollCycle>;
    readonly run: (instance: LoadedInstance) => Effect.Effect<never>;
  }
>()("@usine/orchestrator/PollingTriggers") {
  static readonly layer = Layer.effect(
    PollingTriggers,
    Effect.gen(function* () {
      const cursors = yield* CursorStore;
      const config = yield* ConfigParser;
      const expressions = yield* ExpressionEngine;
      const github = yield* GitHubPolling;
      const runs = yield* RunEngine;

      const readCursor = Effect.fn("PollingTriggers.readCursor")(function* (
        watched: WatchedRepository,
      ) {
        const stored = yield* cursors.read(cursorKey(watched.repository), StoredPollCursor);
        if (Option.isNone(stored)) return PollCursor.empty;
        if (!sameWatches(stored.value.watches, watched.watches)) {
          yield* Effect.logInfo("Watched loops changed; re-polling the repository from scratch", {
            repository: watched.repository.name,
            previousWatches: stored.value.watches.length,
            currentWatches: watched.watches.length,
          });
          return PollCursor.empty;
        }
        return stored.value.cursor;
      });

      const writeCursor = Effect.fn("PollingTriggers.writeCursor")(
        (watched: WatchedRepository, cursor: PollCursor) =>
          cursors.write(
            cursorKey(watched.repository),
            StoredPollCursor,
            new StoredPollCursor({ cursor, watches: watched.watches }),
          ),
      );

      const evaluateItem = Effect.fn("PollingTriggers.evaluateItem")(function* (
        watched: WatchedRepository,
        item: ChangedItem,
      ) {
        const loops = watched.loops.filter(({ loop }) => loop.trigger.on === itemStream(item));
        if (loops.length === 0) {
          return { submissions: [], revokedRuns: 0 } satisfies ItemCycle;
        }

        const snapshot = yield* github.snapshot(watched.repository.name, item);
        // Both snapshot variants carry their payload; the union needs no recheck.
        const payload: Schema.JsonObject = snapshot.payload;
        const context = { repo: repositoryContext(watched.repository), item: payload };
        const stableItemKey = itemKey(watched.repository, item);
        yield* Effect.logDebug("Fetched changed-item snapshot", {
          repository: watched.repository.name,
          item: item.number,
          stream: itemStream(item),
          contentHash: snapshot.contentHash,
        });
        const submissions: Array<SubmissionResult> = [];
        let revokedRuns = 0;
        for (const { agent, loop, parentModel } of loops) {
          const matches = yield* expressions.evaluateBoolean(
            loop.trigger.if,
            environmentFor(loop.trigger.on),
            context,
          );
          if (!matches) {
            const revoked = yield* runs.revoke(loop.name, stableItemKey);
            revokedRuns += revoked.length;
            if (revoked.length > 0) {
              yield* Effect.logInfo("Item stopped matching; revoked its unstarted runs", {
                repository: watched.repository.name,
                loop: loop.name,
                item: item.number,
                runIds: revoked.join(", "),
              });
            }
            continue;
          }

          const dedupKey = eventKey(loop, watched.repository, item, snapshot);
          const receivedAt = yield* DateTime.now;
          const task = yield* config.renderPrompt(loop, context);
          const submitted = yield* runs.submit(
            triggerSubmission({
              dedupKey,
              itemKey: stableItemKey,
              loop,
              payload,
              receivedAt,
              repository: watched.repository,
              task: AttemptChannel.Task.make(task),
              agent,
              parentModel,
            }),
          );
          yield* Effect.logInfo("Submitted matching item state", {
            repository: watched.repository.name,
            loop: loop.name,
            item: item.number,
            contentHash: snapshot.contentHash,
            result: submitted._tag,
            ...submissionLogFields(submitted),
          });
          submissions.push(submitted);
        }
        return { submissions, revokedRuns } satisfies ItemCycle;
      });

      const pollRepository = Effect.fn("PollingTriggers.pollRepository")(function* (
        watched: WatchedRepository,
      ) {
        yield* Effect.annotateCurrentSpan({ repository: watched.repository.name });
        const cursor = yield* readCursor(watched);
        const detected = yield* github.changes(watched.repository.name, cursor);
        if (detected._tag === "RepositoryNotModified") {
          yield* Effect.logDebug("Repository unchanged (304)", {
            repository: watched.repository.name,
          });
          return {
            changedItems: 0,
            submissions: [],
            revokedRuns: 0,
            nextPollAt: detected.nextPollAt,
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
        yield* writeCursor(watched, detected.cursor);
        return {
          changedItems: detected.items.length,
          submissions: itemCycles.flatMap(({ submissions }) => submissions),
          revokedRuns: itemCycles.reduce((sum, cycle) => sum + cycle.revokedRuns, 0),
          nextPollAt: detected.nextPollAt,
        } satisfies RepositoryCycle;
      });

      const poll = Effect.fn("PollingTriggers.poll")(function* (instance: LoadedInstance) {
        const watched = yield* watchedRepositories(instance);
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
            errorTag: error._tag,
            message: error.message,
          });
          failures.push(
            new RepositoryPollFailure({
              repository: repository.repository.name,
              errorTag: error._tag,
              message: error.message,
            }),
          );
        }
        return new PollCycle({
          repositories: watched.length,
          changedItems: cycles.reduce((sum, cycle) => sum + cycle.changedItems, 0),
          submissions: cycles.flatMap(({ submissions }) => submissions),
          revokedRuns: cycles.reduce((sum, cycle) => sum + cycle.revokedRuns, 0),
          failures,
          nextPollAt: latestPollAt([...cycles.map(({ nextPollAt }) => nextPollAt), ...backoffs]),
        });
      });

      // No Effect.fn here: `run` never returns, so a named wrapper would open
      // a span that never closes. Each cycle's span lives on `poll`.
      const run = (instance: LoadedInstance): Effect.Effect<never> =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const cycle = yield* poll(instance);
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

      return { poll, run };
    }),
  );
}
