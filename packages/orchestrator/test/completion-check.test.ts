import { assert, it } from "@effect/vitest";
import { GitHubApiError } from "@usine/github/github-app";
import {
  ContentHash,
  GitHubPolling,
  PullRequestPayload,
  PullRequestSnapshot,
  IssuePayload,
  IssueSnapshot,
} from "@usine/github/polling";
import { CompletionCheck } from "@usine/engine/step-executor";
import { Submission } from "@usine/engine/engine";
import { Event } from "@usine/core/event";
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { completionCheckLayer } from "../src/completion-check.ts";
import { submission } from "./local-worker/support.ts";
import { unmovedBaseRefHead } from "./support/polling.ts";

const payload = Schema.decodeEffect(PullRequestPayload)({
  number: 1,
  title: "Change",
  body: "",
  url: "https://github.com/acme/demo/pull/1",
  state: "OPEN",
  isDraft: false,
  merged: false,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  mergedAt: null,
  author: null,
  baseRefName: "main",
  headRefName: "change",
  headRefOid: "a".repeat(40),
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  reviewDecision: null,
  statusCheckRollup: null,
  labels: { totalCount: 0, nodes: [] },
  reviewRequests: { totalCount: 0, nodes: [] },
  reviews: { totalCount: 0, nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  closingIssuesReferences: { totalCount: 0, nodes: [] },
  reviewThreads: { totalCount: 0, nodes: [] },
});

const layerWith = (snapshot: GitHubPolling["Service"]["snapshot"]) =>
  completionCheckLayer.pipe(
    Layer.provide(
      Layer.succeed(GitHubPolling)({
        baseRefHead: unmovedBaseRefHead,
        missingIssues: () => Effect.succeed([]),
        changes: () => Effect.die("unused"),
        labels: () => Effect.die("unused"),
        snapshot,
      }),
    ),
  );

const request = (eventPayload: Schema.Json) => {
  const saved = submission(1);
  return Submission.make({
    ...saved,
    event: Event.make({ ...saved.event, payload: eventPayload }),
    outcomeLabels: ["review-passed", "agent-review-findings"],
  });
};

it.effect.each([
  [],
  ["review-passed"],
  ["agent-review-findings"],
  ["REVIEW-PASSED"],
  ["unrelated"],
])("verifies a fresh PR snapshot with labels %j instead of trusting the event", (labels) =>
  Effect.gen(function* () {
    const saved = yield* payload;
    const observed = request({
      ...saved,
      labels: { totalCount: 1, nodes: [{ name: "review-passed" }] },
    });
    const calls: string[] = [];
    const result = yield* Effect.gen(function* () {
      const verify = yield* CompletionCheck;
      return yield* verify(observed).pipe(Effect.result);
    }).pipe(
      Effect.provide(
        layerWith((repository, item) => {
          calls.push(item._tag);
          assert.strictEqual(repository, observed.repository);
          assert.strictEqual(item.number, 1);
          return Effect.succeed(
            PullRequestSnapshot.make({
              contentHash: ContentHash.make("b".repeat(64)),
              payload: PullRequestPayload.make({
                ...saved,
                labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
              }),
            }),
          );
        }),
      ),
    );
    assert.deepStrictEqual(calls, ["ChangedPullRequest"]);
    if (labels.length === 0 || labels[0] === "unrelated") {
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "AgentFailure");
        assert.include(result.failure.message, "without an outcome label");
      }
    } else assert.strictEqual(result._tag, "Success");
  }),
);

it.effect("fetches issue outcomes through the issue stream", () =>
  Effect.gen(function* () {
    const saved = yield* Schema.decodeEffect(IssuePayload)({
      number: 1,
      title: "Change",
      body: "",
      url: "https://github.com/acme/demo/issues/1",
      state: "OPEN",
      stateReason: null,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      closedAt: null,
      author: null,
      issueType: null,
      milestone: null,
      labels: { totalCount: 0, nodes: [] },
      assignees: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
    });
    yield* Effect.gen(function* () {
      const verify = yield* CompletionCheck;
      yield* verify(request(saved));
    }).pipe(
      Effect.provide(
        layerWith((_repository, item) => {
          assert.strictEqual(item._tag, "ChangedIssue");
          return Effect.succeed(
            IssueSnapshot.make({
              contentHash: ContentHash.make("b".repeat(64)),
              payload: IssuePayload.make({
                ...saved,
                labels: { totalCount: 1, nodes: [{ name: "review-passed" }] },
              }),
            }),
          );
        }),
      ),
    );
  }),
);

it.effect("reports a GitHub read failure instead of accepting an unverified verdict", () =>
  Effect.gen(function* () {
    const saved = yield* payload;
    const result = yield* Effect.gen(function* () {
      const verify = yield* CompletionCheck;
      return yield* verify(request(saved)).pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        layerWith(() =>
          Effect.fail(
            GitHubApiError.make({
              operation: "fetch-pull-request-snapshot",
              status: Option.none(),
              message: "GitHub is unavailable",
            }),
          ),
        ),
      ),
    );
    assert.strictEqual(result._tag, "InfraFailure");
  }),
);

it.effect("bounds a stalled outcome check at five seconds", () =>
  Effect.gen(function* () {
    const saved = yield* payload;
    const started = yield* Deferred.make<void>();
    const fiber = yield* Effect.gen(function* () {
      const verify = yield* CompletionCheck;
      return yield* verify(request(saved)).pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        layerWith(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("5 seconds");
    assert.strictEqual((yield* Fiber.join(fiber))._tag, "InfraFailure");
  }),
);
