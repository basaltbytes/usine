import {
  environmentFor,
  type LoadedInstance,
  type LoopFile,
  type ManagedRepo,
  matchesSelector,
} from "@usine/config";
import { Event, Item } from "@usine/core";
import {
  CursorEntry,
  CursorKey,
  CursorStore,
  EnginePersistenceError,
  RunEngine,
  Submission,
  SubmissionResult,
  type RunEngineError,
} from "@usine/engine";
import { ExpressionEngine, type ExpressionError } from "@usine/expression";
import {
  GitHubPolling,
  PayloadHashError,
  PollCursor,
  type ChangedItem,
  type GitHubAppError,
  type PayloadSnapshot,
} from "@usine/github";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";

const WatchKey = Schema.NonEmptyString.pipe(Schema.brand("GitHubPollWatchKey"));
type WatchKey = typeof WatchKey.Type;

class StoredPollCursor extends Schema.Class<StoredPollCursor>(
  "@usine/orchestrator/StoredPollCursor",
)({
  cursor: PollCursor,
  watches: Schema.Array(WatchKey).check(Schema.isUnique()),
}) {}

export class PollCycle extends Schema.Class<PollCycle>("@usine/orchestrator/PollCycle")({
  repositories: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  changedItems: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  submissions: Schema.Array(SubmissionResult),
  revocations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
}) {}

export type PollingTriggersError =
  | ExpressionError
  | GitHubAppError
  | PayloadHashError
  | RunEngineError;

interface WatchedRepository {
  readonly repository: ManagedRepo;
  readonly loops: ReadonlyArray<LoopFile>;
  readonly watches: ReadonlyArray<WatchKey>;
}

interface RepositoryCycle {
  readonly changedItems: number;
  readonly submissions: ReadonlyArray<SubmissionResult>;
  readonly revocations: number;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

const canonicalRepository = (repository: string): string => repository.toLowerCase();

const cursorKey = (repository: ManagedRepo): CursorKey =>
  CursorKey.make(`github-poll:${canonicalRepository(repository.name)}`);

const watchKey = (loop: LoopFile): WatchKey =>
  WatchKey.make(JSON.stringify([loop.name, loop.trigger.on, loop.trigger.if]));

const watchedRepositories = (instance: LoadedInstance): ReadonlyArray<WatchedRepository> =>
  instance.config.repos.flatMap((repository) => {
    const loops = instance.loops.filter(
      (loop) => loop.trigger.on !== "schedule" && matchesSelector(loop.selector, repository),
    );
    if (loops.length === 0) return [];
    return [
      {
        repository,
        loops,
        watches: loops.map(watchKey).sort(),
      },
    ];
  });

const sameWatches = (left: ReadonlyArray<WatchKey>, right: ReadonlyArray<WatchKey>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const decodeStoredCursor = (
  value: Schema.Json,
): Effect.Effect<StoredPollCursor, EnginePersistenceError> =>
  Schema.decodeUnknownEffect(StoredPollCursor)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) => new EnginePersistenceError({ operation: "decode GitHub polling cursor", cause }),
    ),
  );

const encodeStoredCursor = (
  value: StoredPollCursor,
): Effect.Effect<Schema.Json, EnginePersistenceError> =>
  Schema.encodeEffect(StoredPollCursor)(value).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
    Effect.mapError(
      (cause) => new EnginePersistenceError({ operation: "encode GitHub polling cursor", cause }),
    ),
  );

const itemStream = (item: ChangedItem): "issue" | "pr" =>
  item._tag === "ChangedIssue" ? "issue" : "pr";

const payloadFor = (
  item: ChangedItem,
  snapshot: PayloadSnapshot,
): Effect.Effect<Schema.JsonObject> =>
  (item._tag === "ChangedIssue" && snapshot._tag !== "IssueSnapshot") ||
  (item._tag === "ChangedPullRequest" && snapshot._tag !== "PullRequestSnapshot")
    ? Effect.die(new Error(`GitHub returned ${snapshot._tag} for ${item._tag}`))
    : Effect.succeed(snapshot.payload);

const itemKey = (repository: ManagedRepo, item: ChangedItem): Item.ItemKey =>
  Item.ItemKey.make(JSON.stringify(["github", canonicalRepository(repository.name), item.number]));

const eventKey = (
  loop: LoopFile,
  repository: ManagedRepo,
  item: ChangedItem,
  snapshot: PayloadSnapshot,
): Event.DedupKey =>
  Event.DedupKey.make(
    JSON.stringify([
      loop.name,
      canonicalRepository(repository.name),
      item.number,
      snapshot.contentHash,
    ]),
  );

const repositoryContext = (repository: ManagedRepo): Schema.JsonObject => {
  const separator = repository.name.indexOf("/");
  const owner = repository.name.slice(0, separator);
  return {
    name: repository.name,
    owner,
    url: `https://github.com/${repository.name}`,
  };
};

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
    readonly poll: (instance: LoadedInstance) => Effect.Effect<PollCycle, PollingTriggersError>;
    readonly run: (instance: LoadedInstance) => Effect.Effect<never, PollingTriggersError>;
  }
>()("@usine/orchestrator/PollingTriggers") {
  static readonly layer = Layer.effect(
    PollingTriggers,
    Effect.gen(function* () {
      const cursors = yield* CursorStore;
      const expressions = yield* ExpressionEngine;
      const github = yield* GitHubPolling;
      const runs = yield* RunEngine;

      const readCursor = Effect.fn("PollingTriggers.readCursor")(function* (
        watched: WatchedRepository,
      ) {
        const stored = yield* cursors.read(cursorKey(watched.repository));
        if (Option.isNone(stored)) return PollCursor.empty;
        const decoded = yield* decodeStoredCursor(stored.value);
        return sameWatches(decoded.watches, watched.watches) ? decoded.cursor : PollCursor.empty;
      });

      const writeCursor = Effect.fn("PollingTriggers.writeCursor")(function* (
        watched: WatchedRepository,
        cursor: PollCursor,
      ) {
        const value = yield* encodeStoredCursor(
          new StoredPollCursor({ cursor, watches: watched.watches }),
        );
        yield* cursors.write(new CursorEntry({ key: cursorKey(watched.repository), value }));
      });

      const evaluateItem = Effect.fn("PollingTriggers.evaluateItem")(function* (
        watched: WatchedRepository,
        item: ChangedItem,
      ) {
        const loops = watched.loops.filter(({ trigger }) => trigger.on === itemStream(item));
        if (loops.length === 0) {
          const empty: RepositoryCycle = {
            changedItems: 1,
            submissions: [],
            revocations: 0,
            nextPollAt: Option.none(),
          };
          return empty;
        }

        const snapshot = yield* github.snapshot(watched.repository.name, item);
        const payload = yield* payloadFor(item, snapshot);
        const context = { repo: repositoryContext(watched.repository), item: payload };
        const submissions: Array<SubmissionResult> = [];
        let revocations = 0;
        for (const loop of loops) {
          const matches = yield* expressions.evaluateBoolean(
            loop.trigger.if,
            environmentFor(loop.trigger.on),
            context,
          );
          const stableItemKey = itemKey(watched.repository, item);
          if (!matches) {
            yield* runs.revoke(loop.name, stableItemKey);
            revocations += 1;
            continue;
          }

          const dedupKey = eventKey(loop, watched.repository, item, snapshot);
          const receivedAt = yield* DateTime.now;
          submissions.push(
            yield* runs.submit(
              new Submission({
                event: new Event.Event({
                  id: Event.EventId.make(dedupKey),
                  dedupKey,
                  payload,
                  receivedAt,
                }),
                itemKey: stableItemKey,
                loop: loop.name,
                step: loop.step,
                approval: loop.approval,
              }),
            ),
          );
        }
        const result: RepositoryCycle = {
          changedItems: 1,
          submissions,
          revocations,
          nextPollAt: Option.none(),
        };
        return result;
      });

      const pollRepository = Effect.fn("PollingTriggers.pollRepository")(function* (
        watched: WatchedRepository,
      ) {
        const cursor = yield* readCursor(watched);
        const detected = yield* github.changes(watched.repository.name, cursor);
        if (detected._tag === "RepositoryNotModified") {
          const unchanged: RepositoryCycle = {
            changedItems: 0,
            submissions: [],
            revocations: 0,
            nextPollAt: detected.nextPollAt,
          };
          return unchanged;
        }

        const itemCycles = yield* Effect.forEach(
          detected.items,
          (item) => evaluateItem(watched, item),
          { concurrency: 4 },
        );
        // Advancing is the commit point: every changed item was fetched,
        // evaluated, and submitted/revoked successfully. A prior failure
        // leaves the old cursor so the next cycle safely re-polls.
        yield* writeCursor(watched, detected.cursor);
        return {
          changedItems: itemCycles.reduce((sum, cycle) => sum + cycle.changedItems, 0),
          submissions: itemCycles.flatMap(({ submissions }) => submissions),
          revocations: itemCycles.reduce((sum, cycle) => sum + cycle.revocations, 0),
          nextPollAt: detected.nextPollAt,
        } satisfies RepositoryCycle;
      });

      const poll = Effect.fn("PollingTriggers.poll")(function* (instance: LoadedInstance) {
        const watched = watchedRepositories(instance);
        const cycles = yield* Effect.forEach(watched, pollRepository, { concurrency: 4 });
        return new PollCycle({
          repositories: watched.length,
          changedItems: cycles.reduce((sum, cycle) => sum + cycle.changedItems, 0),
          submissions: cycles.flatMap(({ submissions }) => submissions),
          revocations: cycles.reduce((sum, cycle) => sum + cycle.revocations, 0),
          nextPollAt: latestPollAt(cycles.map(({ nextPollAt }) => nextPollAt)),
        });
      });

      const run = Effect.fn("PollingTriggers.run")(function* (instance: LoadedInstance) {
        while (true) {
          const startedAt = yield* Clock.currentTimeMillis;
          const recommended = yield* poll(instance).pipe(
            Effect.map(({ nextPollAt }) => nextPollAt),
            Effect.catchTag("GitHubRateLimitError", ({ retryAt }) =>
              Effect.succeed(Option.some(retryAt)),
            ),
          );
          const intervalAt = startedAt + instance.config.settings.pollInterval * 1_000;
          const target = Option.match(recommended, {
            onNone: () => intervalAt,
            onSome: (value) => Math.max(intervalAt, DateTime.toEpochMillis(value)),
          });
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.sleep(Duration.millis(Math.max(0, target - now)));
        }
        // The loop is intentionally endless; this keeps its public success
        // channel `never` without a narrowing assertion.
        return yield* Effect.never;
      });

      return { poll, run };
    }),
  );
}
