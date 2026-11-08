import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { WorkerName } from "@usine/core/worker";
import { StepCompletion, StepResult } from "@usine/core/step/result";
import { RunEngine } from "@usine/engine/engine";
import { layer as engineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { TriggerCondition, TriggerRecheck } from "@usine/engine/trigger-condition";
import { GitHubApiError } from "@usine/github/github-app";
import {
  GitHubPolling,
  PullRequestPayload,
  IssuePayload,
  RepositoryLabel,
  RepositoryLabelName,
  RepositoryLabelColor,
} from "@usine/github/polling";
import { CompletionCheck } from "@usine/engine/step-executor";
import { Submission } from "@usine/engine/engine";
import { Event } from "@usine/core/event";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { completionCheckLayer } from "../src/completion-check.ts";
import { submission, waitFor } from "./local-worker/support.ts";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
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

const layerWith = (itemLabels: GitHubPolling["Service"]["itemLabels"]) =>
  completionCheckLayer.pipe(
    Layer.provide(
      Layer.succeed(GitHubPolling)({
        baseRefHead: unmovedBaseRefHead,
        missingIssues: () => Effect.succeed([]),
        changes: () => Effect.die("unused"),
        labels: () => Effect.die("unused"),
        snapshot: () => Effect.die("Verification must only read labels"),
        itemLabels,
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
])("verifies current PR labels %j instead of trusting the event", (labels) =>
  Effect.gen(function* () {
    const saved = yield* payload;
    const observed = request({
      ...saved,
      labels: { totalCount: 1, nodes: [{ name: "review-passed" }] },
    });
    const calls: number[] = [];
    const result = yield* Effect.gen(function* () {
      const verify = yield* CompletionCheck;
      return yield* verify(observed).pipe(Effect.result);
    }).pipe(
      Effect.provide(
        layerWith((repository, item) => {
          calls.push(item);
          assert.strictEqual(repository, observed.repository);
          assert.strictEqual(item, 1);
          return Effect.succeed(
            labels.map((name) =>
              RepositoryLabel.make({
                name: RepositoryLabelName.make(name),
                color: RepositoryLabelColor.make("ededed"),
                description: Option.none(),
              }),
            ),
          );
        }),
      ),
    );
    assert.deepStrictEqual(calls, [1]);
    if (labels.length === 0 || labels[0] === "unrelated") {
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "AgentFailure");
        assert.include(result.failure.message, "without an outcome label");
      }
    } else assert.strictEqual(result._tag, "Success");
  }),
);

it.effect("fetches issue outcome labels", () =>
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
          assert.strictEqual(item, 1);
          return Effect.succeed([
            RepositoryLabel.make({
              name: RepositoryLabelName.make("review-passed"),
              color: RepositoryLabelColor.make("ededed"),
              description: Option.none(),
            }),
          ]);
        }),
      ),
    );
  }),
);

it.effect("exhausts label read retries with a non-retryable failure", () =>
  Effect.gen(function* () {
    const saved = yield* payload;
    const started = yield* Deferred.make<void>();
    let reads = 0;
    const fiber = yield* Effect.gen(function* () {
      const verify = yield* CompletionCheck;
      return yield* verify(request(saved)).pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        layerWith(() =>
          Effect.gen(function* () {
            reads += 1;
            yield* Deferred.succeed(started, undefined);
            return yield* GitHubApiError.make({
              operation: "fetch-item-labels",
              status: Option.none(),
              message: "GitHub is unavailable",
            });
          }),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("3 seconds");
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result._tag, "AgentFailure");
    assert.include(result.message, "GitHub is unavailable");
    assert.strictEqual(reads, 3);
  }),
);

it.effect("bounds each label read and stops after three timeouts", () =>
  Effect.gen(function* () {
    const saved = yield* payload;
    const started = yield* Deferred.make<void>();
    let reads = 0;
    const fiber = yield* Effect.gen(function* () {
      const verify = yield* CompletionCheck;
      return yield* verify(request(saved)).pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        layerWith(() =>
          Effect.gen(function* () {
            reads += 1;
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("48 seconds");
    assert.strictEqual((yield* Fiber.join(fiber))._tag, "AgentFailure");
    assert.strictEqual(reads, 3);
  }),
);

it.live.each(["recovers", "exhausts"] as const)(
  "%s verification reads without executing the agent again",
  (scenario) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-completion-",
      });
      const directory = InstanceDirectory.make(temporaryDirectory);
      let executions = 0;
      let reads = 0;
      const worker = WorkerName.make("local");
      const executor = Layer.succeed(StepExecutor)({
        workers: Effect.succeed([worker]),
        isLive: () => Effect.succeed(false),
        outcome: () => Effect.succeedNone,
        recover: () => Effect.void,
        intervene: () => Effect.void,
        interrupt: () => Effect.void,
        occupy: () => Effect.succeed({ worker, release: Effect.void }),
        sweep: Effect.void,
        discard: () => Effect.void,
        reserve: () => Effect.succeed({ worker, release: Effect.void }),
        execute: () =>
          Effect.sync(() => {
            executions += 1;
            return StepCompletion.fromResult(
              StepResult.make({ message: "Review published.", facts: [] }),
            );
          }),
      });
      const check = layerWith(() =>
        Effect.gen(function* () {
          reads += 1;
          if (scenario === "recovers" && reads === 3) {
            return [
              RepositoryLabel.make({
                name: RepositoryLabelName.make("review-passed"),
                color: RepositoryLabelColor.make("ededed"),
                description: Option.none(),
              }),
            ];
          }
          return yield* GitHubApiError.make({
            operation: "fetch-item-labels",
            status: Option.none(),
            message: "GitHub is unavailable",
          });
        }),
      );
      const saved = yield* payload;
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(request(saved));
        assert(accepted._tag === "Claimed");
        const finished = yield* waitFor(
          engine,
          accepted.runId,
          scenario === "recovers" ? "Succeeded" : "Failed",
        );
        assert.strictEqual(finished.attempts.length, 1);
        assert.strictEqual(executions, 1);
        assert.strictEqual(reads, 3);
        if (scenario === "exhausts") {
          const outcome = finished.attempts[0]?.outcome;
          assert(
            outcome !== undefined && Option.isSome(outcome) && outcome.value._tag === "Failed",
          );
          assert.strictEqual(outcome.value.failure._tag, "AgentFailure");
        }
      }).pipe(
        Effect.provide(
          engineLayer(directory).pipe(
            Layer.provide(executor),
            Layer.provide(check),
            Layer.provide(
              Layer.succeed(TriggerCondition)({
                recheck: (submission) => Effect.succeed(TriggerRecheck.Matches({ submission })),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
