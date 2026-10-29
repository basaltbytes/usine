import { assert, describe, it } from "@effect/vitest";
import { LoadedInstance } from "@usine/config/instance";
import { UsineConfig } from "@usine/config/factory";
import { RepositoryName } from "@usine/core/repository";
import { GitHubApiError, GitHubRateLimitError } from "@usine/github/github-app";
import {
  ChangedIssue,
  ContentHash,
  GitHubPolling,
  IssueSnapshot,
  PollCursor,
  RepositoryChanges,
  RepositoryLabelCatalog,
  RepositoryNotModified,
} from "@usine/github/polling";
import { Clock, DateTime, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { fixedInstance } from "./support/current-instance.ts";
import { pollingTestLayer, unmovedBaseRefHead } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
    settings: { poll_interval: 60 },
  }),
  agents: [],
  loops: [],
  invalidAgents: [],
  quarantinedLoops: [],
  warnings: [],
});
const changed = new ChangedIssue({
  number: 74,
  updatedAt: DateTime.makeUnsafe("2026-09-06T12:00:00Z"),
});
const snapshot = new IssueSnapshot({
  contentHash: ContentHash.make("a".repeat(64)),
  payload: {
    number: 74,
    title: "Online backup",
    body: "",
    url: "https://github.com/basaltbytes/usine/issues/74",
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-09-06T10:00:00Z",
    updatedAt: "2026-09-06T12:00:00Z",
    closedAt: null,
    author: null,
    issueType: null,
    milestone: null,
    labelEvents: {},
    labels: { totalCount: 0, nodes: [] },
    assignees: { totalCount: 0, nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
  },
});
const labels = () =>
  Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] }));

describe("Polling self-write Hints", () => {
  it.effect("coalesces repository hints without moving the 60-second backstop", () => {
    let requests = 0;
    const github: GitHubPolling["Service"] = {
      baseRefHead: unmovedBaseRefHead,
      missingIssues: () => Effect.succeed([]),
      labels,
      changes: (_repository, cursor) =>
        Effect.sync(() => {
          requests += 1;
          return new RepositoryNotModified({ cursor, nextPollAt: Option.none() });
        }),
      snapshot: () => Effect.die("no item changed"),
    };
    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      assert(Option.isNone(yield* polling.lastHint));
      for (let index = 0; index < 20; index += 1) yield* polling.hint(repository);
      yield* polling.hint(RepositoryName.make("unknown/repository"));
      assert(Option.isSome(yield* polling.lastHint));
      const fiber = yield* polling.run(fixedInstance(instance)).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(requests, 2, "one full poll and one coalesced repository refresh");
      yield* TestClock.adjust("59998 millis");
      assert.strictEqual(requests, 2);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(requests, 3, "the backstop still starts at 60 seconds");
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(pollingTestLayer(github)));
  });

  it.effect("extends an in-flight wait when another writer reports a later retry deadline", () => {
    let snapshots = 0;
    const github: GitHubPolling["Service"] = {
      baseRefHead: unmovedBaseRefHead,
      missingIssues: () => Effect.succeed([]),
      labels,
      changes: (_repository, cursor) =>
        Effect.succeed(new RepositoryNotModified({ cursor, nextPollAt: Option.none() })),
      snapshot: () =>
        Effect.sync(() => {
          snapshots += 1;
          return snapshot;
        }),
    };
    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const fiber = yield* polling.run(fixedInstance(instance)).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 millis");
      yield* polling.hint(repository, changed, Option.some(DateTime.makeUnsafe(90_000)));
      yield* TestClock.adjust("40 seconds");
      yield* polling.hint(repository, changed, Option.some(DateTime.makeUnsafe(180_000)));
      yield* TestClock.adjust("49999 millis");
      assert.strictEqual(
        snapshots,
        0,
        "the old deadline cannot release a wait extended by another writer",
      );
      yield* TestClock.adjust("90 seconds");
      assert(snapshots > 0);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(pollingTestLayer(github)));
  });

  it.effect("coalesces queued Hints and preserves the normal conditional-poll cadence", () => {
    let requests = 0;
    let snapshots = 0;
    const github: GitHubPolling["Service"] = {
      baseRefHead: unmovedBaseRefHead,
      missingIssues: () => Effect.succeed([]),
      labels,
      changes: (_repository, cursor) =>
        Effect.gen(function* () {
          requests += 1;
          return new RepositoryNotModified({
            cursor,
            nextPollAt: Option.some(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 120_000),
            ),
          });
        }),
      snapshot: () =>
        Effect.sync(() => {
          snapshots += 1;
          return snapshot;
        }),
    };
    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      for (let index = 0; index < 20; index += 1) yield* polling.hint(repository, changed);
      const fiber = yield* polling.run(fixedInstance(instance)).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(snapshots, 1);
      assert.strictEqual(requests, 1);
      const latest = yield* polling.latest;
      assert(Option.isSome(latest));
      assert.strictEqual(
        latest.value.changedItems,
        0,
        "a Hint leaves the last complete cycle intact",
      );
      yield* TestClock.adjust("119999 millis");
      assert.strictEqual(requests, 2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(pollingTestLayer(github)));
  });

  for (const backoff of ["response", "error"] as const) {
    it.effect(`honors true request backoff from a ${backoff} before fetching a Hint`, () => {
      let requests = 0;
      let snapshots = 0;
      const until = DateTime.makeUnsafe(90_000);
      const github: GitHubPolling["Service"] = {
        baseRefHead: unmovedBaseRefHead,
        missingIssues: () => Effect.succeed([]),
        labels,
        changes: (_repository, cursor) =>
          Effect.suspend(() => {
            requests += 1;
            return backoff === "error"
              ? Effect.fail(
                  new GitHubRateLimitError({
                    operation: "poll-repository-changes",
                    retryAt: until,
                    message: "Wait before retrying",
                  }),
                )
              : Effect.succeed(
                  new RepositoryNotModified({
                    cursor,
                    nextPollAt: Option.some(until),
                    backoffUntil: Option.some(until),
                  }),
                );
          }),
        snapshot: () =>
          Effect.sync(() => {
            snapshots += 1;
            return snapshot;
          }),
      };
      return Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const fiber = yield* polling.run(fixedInstance(instance)).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 millis");
        yield* polling.hint(repository, changed);
        yield* TestClock.adjust("89998 millis");
        assert.strictEqual(snapshots, 0);
        assert.strictEqual(requests, 1);
        yield* TestClock.adjust("1 millis");
        assert.strictEqual(snapshots, 1);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(pollingTestLayer(github)));
    });
  }

  it.effect(
    "serializes a slow Hint with explicit polls and lets the backstop repair a failed snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotStarted = yield* Deferred.make<void>();
        const releaseSnapshot = yield* Deferred.make<void>();
        let requests = 0;
        let snapshots = 0;
        const github: GitHubPolling["Service"] = {
          baseRefHead: unmovedBaseRefHead,
          missingIssues: () => Effect.succeed([]),
          labels,
          changes: (_repository, cursor) =>
            Effect.sync(() => {
              requests += 1;
              return requests === 1
                ? new RepositoryNotModified({ cursor, nextPollAt: Option.none() })
                : new RepositoryChanges({
                    cursor: PollCursor.empty,
                    items: [changed],
                    backlog: false,
                    nextPollAt: Option.none(),
                  });
            }),
          snapshot: () =>
            Effect.gen(function* () {
              snapshots += 1;
              if (snapshots === 1) {
                yield* Deferred.succeed(snapshotStarted, undefined);
                yield* Deferred.await(releaseSnapshot);
                return yield* new GitHubApiError({
                  operation: "fetch-issue-snapshot",
                  status: Option.some(503),
                  message: "Temporary snapshot failure",
                });
              }
              return snapshot;
            }),
        };
        yield* Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const background = yield* polling.run(fixedInstance(instance)).pipe(Effect.forkChild);
          yield* TestClock.adjust("1 millis");
          yield* polling.hint(repository, changed);
          yield* Deferred.await(snapshotStarted);
          const explicit = yield* polling.poll(instance).pipe(Effect.forkChild);
          yield* TestClock.adjust("1 millis");
          assert.strictEqual(requests, 1, "the conditional poll waits for the in-flight Hint");
          yield* Deferred.succeed(releaseSnapshot, undefined);
          const recovered = yield* Fiber.join(explicit);
          assert.strictEqual(recovered.changedItems, 1);
          assert.deepStrictEqual(recovered.failures, []);
          assert.strictEqual(snapshots, 2);
          yield* Fiber.interrupt(background);
        }).pipe(Effect.provide(pollingTestLayer(github)));
      }),
  );
});
