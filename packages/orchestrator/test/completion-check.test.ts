import { assert, describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { UsineConfig } from "@usine/config/factory";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { Event } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { jsonKey } from "@usine/core/json-key";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { StepCompletion, StepResult } from "@usine/core/step/result";
import { type BotAccount, BotLogin, WorkerName } from "@usine/core/worker";
import { CompletionCheck } from "@usine/engine/completion-check";
import { RunEngine, Submission } from "@usine/engine/engine";
import { layer as engineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { GitHubApiError, GitHubApp, type GitHubAppError } from "@usine/github/github-app";
import {
  GitHubItemHistory,
  GitHubItemNotFoundError,
  type ItemChange,
  LabelAdded,
  LabelRemoved,
} from "@usine/github/item-history";
import {
  GitHubPolling,
  RepositoryLabel,
  RepositoryLabelColor,
  RepositoryLabelName,
} from "@usine/github/polling";
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { completionCheckLayer } from "../src/completion-check.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import { engineItemChecksLayer } from "../src/runtime.ts";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { fixedConfigLayer } from "./support/current-instance.ts";
import { testAppLayer, testBotAccount } from "./support/github-app.ts";
import { submission, waitFor } from "./local-worker/support.ts";
import { alwaysHoldsLayer, unmovedBaseRefHead } from "./support/polling.ts";

const repository = RepositoryName.make("acme/demo");
const appActor = testBotAccount.login;
const exeActor = BotLogin.make("exe-dev-github-integration[bot]");
const startedAt = DateTime.makeUnsafe("2026-11-08T15:50:10.400Z");
const at = (iso: string) => DateTime.makeUnsafe(iso);

const instanceLayer = Layer.unwrap(
  Schema.decodeEffect(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
    workers: [
      { name: "local", kind: "local", max_concurrent_attempts: 1 },
      { name: "exe-one", kind: "exe.dev", max_concurrent_attempts: 1 },
    ],
  }).pipe(Effect.map(fixedConfigLayer), Effect.orDie),
);

const attemptOn = (worker: string) =>
  Attempt.make({
    id: AttemptId.make("run-1/review/1"),
    runId: RunId.make("run-1"),
    stepName: StepName.make("review"),
    worker: WorkerName.make(worker),
    number: AttemptNumber.make(1),
    brain: BrainSpec.make({
      harness: Harness.make("claude"),
      model: ModelId.make("claude-sonnet-4-6"),
      effort: "high",
    }),
    task: AttemptTask.make("Review the pull request."),
    agent: AgentName.make("reviewer"),
    operatorIntervened: false,
    parentModel: Option.none(),
    startedAt,
    outcome: Option.none(),
    endedAt: Option.none(),
    salvage: Option.none(),
  });

const review = (itemKey: ItemKey = gitHubItemKey(repository, 1)) =>
  Submission.make({
    ...submission(1),
    repository,
    itemKey,
    outcomeLabels: ["ready-to-merge", "agent-review-findings", "ready-for-review"],
  });

const label = (name: string) =>
  RepositoryLabel.make({
    name: RepositoryLabelName.make(name),
    color: RepositoryLabelColor.make("ededed"),
    description: Option.none(),
  });

/** A label change on the Item's timeline and the login that made it. */
interface TimelineEntry {
  readonly actor: BotLogin | "octocat";
  readonly change: ItemChange;
}

const added = (actor: TimelineEntry["actor"], name: string, time: DateTime.Utc): TimelineEntry => ({
  actor,
  change: LabelAdded.make({ at: time, label: label(name) }),
});
const removed = (
  actor: TimelineEntry["actor"],
  name: string,
  time: DateTime.Utc,
): TimelineEntry => ({ actor, change: LabelRemoved.make({ at: time, label: label(name) }) });

type TimelineRead = (
  since: DateTime.Utc,
) => Effect.Effect<ReadonlyArray<TimelineEntry>, GitHubAppError | GitHubItemNotFoundError>;

/**
 * Returns GitHub fakes that record each read. The timeline fake returns every entry of the
 * queried actor and ignores `since`, so the check's own filter decides what counts.
 */
const fakeGitHub = (options: {
  readonly timeline: TimelineRead;
  readonly botAccount?: Effect.Effect<BotAccount, GitHubAppError>;
  readonly labels?: Effect.Effect<ReadonlyArray<string>, GitHubAppError>;
}) => {
  const timeline: Array<{
    readonly actor: BotLogin;
    readonly since: string;
    readonly item: number;
  }> = [];
  const reads = {
    timeline,
    labels: 0,
  };
  const history = Layer.succeed(GitHubItemHistory)({
    appChanges: (_repository, item, since, actor) =>
      Effect.suspend(() => {
        reads.timeline.push({ actor, since: DateTime.formatIso(since), item });
        return options
          .timeline(since)
          .pipe(
            Effect.map((entries) =>
              entries.filter((entry) => entry.actor === actor).map(({ change }) => change),
            ),
          );
      }),
  });
  const polling = Layer.succeed(GitHubPolling)({
    baseRefHead: unmovedBaseRefHead,
    missingIssues: () => Effect.succeed([]),
    changes: () => Effect.die("unused"),
    labels: () => Effect.die("unused"),
    snapshot: () => Effect.die("Verification reads no snapshot"),
    itemLabels: (_repository, item) =>
      Effect.suspend(() => {
        reads.labels += 1;
        assert.strictEqual(item, 1);
        return (options.labels ?? Effect.die("Verification must not read the current labels")).pipe(
          Effect.map((names) => names.map(label)),
        );
      }),
  });
  const app = Layer.effect(
    GitHubApp,
    Effect.map(GitHubApp, (app) => ({ ...app, botAccount: options.botAccount ?? app.botAccount })),
  ).pipe(Layer.provide(testAppLayer));
  const github = Layer.mergeAll(app, history, polling);
  return {
    reads,
    github,
    check: completionCheckLayer.pipe(Layer.provide(github), Layer.provide(instanceLayer)),
  };
};

const verify = (
  attempt: Attempt,
  saved: Submission,
  runAttempts: ReadonlyArray<Attempt> = [attempt],
) =>
  Effect.gen(function* () {
    const check = yield* CompletionCheck;
    return yield* check.verify(attempt, saved, runAttempts).pipe(Effect.result);
  });

const refused = GitHubApiError.make({
  operation: "fetch-item-timeline",
  status: Option.some(403),
  message: "GitHub returned HTTP status 403",
});

/** Returns a scripted Worker whose every Attempt reports a successful review. */
const reviewingExecutor = (executions: { count: number }) => {
  const worker = WorkerName.make("local");
  return Layer.succeed(StepExecutor)({
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
        executions.count += 1;
        return StepCompletion.fromResult(
          StepResult.make({ message: "Review published.", facts: [] }),
        );
      }),
  });
};

const withEngine = <A, E>(
  check: Layer.Layer<CompletionCheck>,
  executions: { count: number },
  use: Effect.Effect<A, E, RunEngine>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
      directory: sqliteTempDirectory(),
      prefix: "usine-completion-",
    });
    const directory = InstanceDirectory.make(temporaryDirectory);
    return yield* use.pipe(
      Effect.provide(
        engineLayer(directory).pipe(
          Layer.provide(reviewingExecutor(executions)),
          Layer.provide(check),
          Layer.provide(alwaysHoldsLayer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

describe("label events", () => {
  it.effect("counts an outcome label that the attempt's writer added during the attempt", () =>
    Effect.gen(function* () {
      const fake = fakeGitHub({
        timeline: () =>
          Effect.succeed([added(appActor, "Ready-To-Merge", at("2026-11-08T15:55:32Z"))]),
      });
      const result = yield* verify(attemptOn("local"), review()).pipe(Effect.provide(fake.check));
      assert.strictEqual(result._tag, "Success");
      assert.deepStrictEqual(fake.reads.timeline, [
        { actor: appActor, since: "2026-11-08T15:50:10.000Z", item: 1 },
      ]);
      assert.strictEqual(fake.reads.labels, 0);
    }),
  );

  it.effect("counts a label added in the second the attempt started", () =>
    Effect.gen(function* () {
      const fake = fakeGitHub({
        timeline: () =>
          Effect.succeed([added(appActor, "ready-for-review", at("2026-11-08T15:50:10Z"))]),
      });
      const result = yield* verify(attemptOn("local"), review()).pipe(Effect.provide(fake.check));
      assert.strictEqual(result._tag, "Success");
    }),
  );

  it.effect("rejects a verdict label left from an earlier cycle", () =>
    Effect.gen(function* () {
      const fake = fakeGitHub({
        timeline: () =>
          Effect.succeed([
            added(appActor, "ready-to-merge", at("2026-11-08T15:40:00Z")),
            added(appActor, "agent-in-progress", at("2026-11-08T15:51:00Z")),
            added("octocat", "agent-review-findings", at("2026-11-08T15:52:00Z")),
          ]),
        labels: Effect.succeed(["ready-to-merge", "agent-review-findings"]),
      });
      const result = yield* verify(attemptOn("local"), review()).pipe(Effect.provide(fake.check));
      assert(result._tag === "Failure");
      assert.strictEqual(result.failure._tag, "AgentFailure");
      assert.strictEqual(
        result.failure.message,
        "The run added no outcome label; expected one of: ready-to-merge, agent-review-findings, ready-for-review.",
      );
      assert.strictEqual(fake.reads.labels, 0);
    }),
  );

  it.effect("counts a verdict from an earlier Attempt in the same Run", () =>
    Effect.gen(function* () {
      const fake = fakeGitHub({
        timeline: () =>
          Effect.succeed([added(appActor, "ready-to-merge", at("2026-11-08T15:55:00Z"))]),
        labels: Effect.succeed(["ready-to-merge"]),
      });
      const retry = Attempt.make({
        ...attemptOn("local"),
        id: AttemptId.make("run-1/review/2"),
        number: AttemptNumber.make(2),
        startedAt: at("2026-11-08T16:00:00Z"),
      });
      const result = yield* verify(retry, review(), [attemptOn("local"), retry]).pipe(
        Effect.provide(fake.check),
      );
      assert.strictEqual(result._tag, "Success");
      assert.deepStrictEqual(fake.reads.timeline, [
        { actor: appActor, since: "2026-11-08T15:50:10.000Z", item: 1 },
      ]);
      assert.strictEqual(fake.reads.labels, 0);
    }),
  );

  it.effect.each([
    ["exe-one", "local", exeActor],
    ["local", "exe-one", appActor],
  ] as const)(
    "counts an earlier verdict when a retry moves from %s to %s",
    ([firstWorker, retryWorker, actor]) =>
      Effect.gen(function* () {
        const fake = fakeGitHub({
          timeline: () =>
            Effect.succeed([
              added(actor, "ready-to-merge", at("2026-11-08T15:55:00Z")),
              removed("octocat", "ready-to-merge", at("2026-11-08T15:56:00Z")),
            ]),
          labels: Effect.succeed([]),
        });
        const retry = Attempt.make({
          ...attemptOn(retryWorker),
          id: AttemptId.make("run-1/review/2"),
          number: AttemptNumber.make(2),
          startedAt: at("2026-11-08T16:00:00Z"),
        });
        const result = yield* verify(retry, review(), [attemptOn(firstWorker), retry]).pipe(
          Effect.provide(fake.check),
        );
        assert.strictEqual(result._tag, "Success");
        assert.strictEqual(fake.reads.labels, 0);
      }),
  );

  it.effect("rejects a verdict from a Worker kind absent from the Run", () =>
    Effect.gen(function* () {
      const fake = fakeGitHub({
        timeline: () =>
          Effect.succeed([added(exeActor, "ready-to-merge", at("2026-11-08T15:55:00Z"))]),
      });
      const result = yield* verify(attemptOn("local"), review()).pipe(Effect.provide(fake.check));
      assert(result._tag === "Failure");
      assert.include(result.failure.message, "added no outcome label");
      assert.strictEqual(fake.reads.labels, 0);
    }),
  );

  it.effect("rejects a review that only removes its outcome trigger label", () =>
    Effect.gen(function* () {
      const fake = fakeGitHub({
        timeline: () =>
          Effect.succeed([removed(appActor, "ready-for-review", at("2026-11-08T15:51:00Z"))]),
        labels: Effect.succeed([]),
      });
      const result = yield* verify(attemptOn("local"), review()).pipe(Effect.provide(fake.check));
      assert(result._tag === "Failure");
      assert.strictEqual(result.failure._tag, "AgentFailure");
      assert.include(result.failure.message, "added no outcome label");
      assert.strictEqual(fake.reads.labels, 0);
    }),
  );

  it.effect("reads the label events of the exe.dev writer for an exe.dev Attempt", () =>
    Effect.gen(function* () {
      const fake = fakeGitHub({
        timeline: () =>
          Effect.succeed([
            added(appActor, "ready-to-merge", at("2026-11-08T15:55:00Z")),
            added(exeActor, "agent-review-findings", at("2026-11-08T15:56:00Z")),
          ]),
      });
      const result = yield* verify(attemptOn("exe-one"), review()).pipe(Effect.provide(fake.check));
      assert.strictEqual(result._tag, "Success");
      assert.deepStrictEqual(
        fake.reads.timeline.map(({ actor }) => actor),
        [exeActor],
      );
    }),
  );

  it.effect("takes the item number from the item key, whatever the stored payload holds", () =>
    Effect.gen(function* () {
      const fake = fakeGitHub({
        timeline: () =>
          Effect.succeed([added(appActor, "ready-to-merge", at("2026-11-08T15:55:00Z"))]),
      });
      const saved = review();
      const result = yield* verify(
        attemptOn("local"),
        Submission.make({
          ...saved,
          event: Event.make({ ...saved.event, payload: { added_by_a_later_release: true } }),
        }),
      ).pipe(Effect.provide(fake.check));
      assert.strictEqual(result._tag, "Success");
      assert.deepStrictEqual(
        fake.reads.timeline.map(({ item }) => item),
        [1],
      );
    }),
  );

  it.effect("fails a schedule Run, which has no issue or pull request, and logs why", () =>
    Effect.gen(function* () {
      const logs: Array<ReadonlyArray<unknown>> = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        logs.push(Array.isArray(message) ? message : [message]);
      });
      const fake = fakeGitHub({ timeline: () => Effect.die("A schedule Run has no timeline") });
      const result = yield* verify(
        attemptOn("local"),
        review(ItemKey.make(jsonKey(["github", repository]))),
      ).pipe(Effect.provide(fake.check), Effect.withLogger(logger));
      assert(result._tag === "Failure");
      assert.strictEqual(
        result.failure.message,
        "Outcome labels require a Run on a GitHub issue or pull request.",
      );
      const logged = logs.find(([message]) => String(message).includes("item key"));
      assert(logged !== undefined);
      const [, fields] = logged;
      assert(
        Option.isSome(
          Schema.decodeUnknownOption(Schema.Struct({ cause: Schema.NonEmptyString }))(fields),
        ),
      );
      assert.strictEqual(fake.reads.labels, 0);
    }),
  );
});

describe("current label fallback", () => {
  it.effect("does not retry a missing item before checking current labels", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fake = fakeGitHub({
        timeline: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(
              GitHubItemNotFoundError.make({
                operation: "fetch-item-timeline",
                item: 1,
                message: "The item is missing from the timeline response",
              }),
            ),
          ),
        labels: Effect.succeed(["ready-to-merge"]),
      });
      const fiber = yield* verify(attemptOn("local"), review()).pipe(
        Effect.provide(fake.check),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("3 seconds");
      assert.strictEqual((yield* Fiber.join(fiber))._tag, "Success");
      assert.strictEqual(fake.reads.timeline.length, 1);
      assert.strictEqual(fake.reads.labels, 1);
    }),
  );

  it.effect.each([
    [[], "Failure"],
    [["unrelated"], "Failure"],
    [["AGENT-REVIEW-FINDINGS"], "Success"],
  ] as const)("verifies current labels %j when the writer is unknown", ([labels, expected]) =>
    Effect.gen(function* () {
      const fake = fakeGitHub({
        timeline: () => Effect.die("An unknown writer has no label events to read"),
        labels: Effect.succeed(labels),
      });
      const result = yield* verify(attemptOn("removed-worker"), review()).pipe(
        Effect.provide(fake.check),
      );
      assert.strictEqual(result._tag, expected);
      if (result._tag === "Failure")
        assert.include(result.failure.message, "ended without an outcome label");
      assert.strictEqual(fake.reads.timeline.length, 0);
      assert.strictEqual(fake.reads.labels, 1);
    }),
  );

  it.effect.each([
    [401, 1],
    [403, 1],
    [404, 1],
    [408, 3],
    [429, 3],
    [502, 3],
  ] as const)("reads label events once more per retry after HTTP %d", ([status, reads]) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fake = fakeGitHub({
        timeline: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(
              GitHubApiError.make({
                operation: "fetch-item-timeline",
                status: Option.some(status),
                message: `GitHub returned HTTP status ${status}`,
              }),
            ),
          ),
        labels: Effect.succeed(["ready-for-review"]),
      });
      const fiber = yield* verify(attemptOn("local"), review()).pipe(
        Effect.provide(fake.check),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("999 millis");
      assert.strictEqual(fake.reads.timeline.length, 1);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(fake.reads.timeline.length, reads === 3 ? 2 : 1);
      yield* TestClock.adjust("1999 millis");
      assert.strictEqual(fake.reads.timeline.length, reads === 3 ? 2 : 1);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual((yield* Fiber.join(fiber))._tag, "Success");
      assert.strictEqual(fake.reads.timeline.length, reads);
      assert.strictEqual(fake.reads.labels, 1);
    }),
  );

  it.effect.each([
    [401, 1],
    [403, 1],
    [404, 1],
    [408, 3],
    [429, 3],
    [503, 3],
  ] as const)("fails after %d on the current labels with %d reads", ([status, reads]) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fake = fakeGitHub({
        timeline: () => Effect.fail(refused),
        labels: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(
            GitHubApiError.make({
              operation: "fetch-item-labels",
              status: Option.some(status),
              message: `GitHub returned HTTP status ${status}`,
            }),
          ),
        ),
      });
      const fiber = yield* verify(attemptOn("local"), review()).pipe(
        Effect.provide(fake.check),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("999 millis");
      assert.strictEqual(fake.reads.labels, 1);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(fake.reads.labels, reads === 3 ? 2 : 1);
      yield* TestClock.adjust("1999 millis");
      assert.strictEqual(fake.reads.labels, reads === 3 ? 2 : 1);
      yield* TestClock.adjust("1 millis");
      const result = yield* Fiber.join(fiber);
      assert(result._tag === "Failure");
      assert.strictEqual(result.failure._tag, "AgentFailure");
      assert.include(result.failure.message, `HTTP status ${status}`);
      assert.strictEqual(fake.reads.labels, reads);
    }),
  );

  it.effect.each(["label events", "current labels"] as const)(
    "recovers from a transport failure reading %s",
    (read) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let calls = 0;
        const transport = GitHubApiError.make({
          operation: read === "label events" ? "fetch-item-timeline" : "fetch-item-labels",
          status: Option.none(),
          message: "connection reset",
        });
        const once = <A>(value: A) =>
          Effect.suspend(() => {
            calls += 1;
            return calls === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(transport))
              : Effect.succeed(value);
          });
        const fake = fakeGitHub({
          timeline: () =>
            read === "label events"
              ? once([added(appActor, "ready-to-merge", at("2026-11-08T15:55:00Z"))])
              : Effect.fail(refused),
          labels: once(["ready-to-merge"]),
        });
        const fiber = yield* verify(attemptOn("local"), review()).pipe(
          Effect.provide(fake.check),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("3 seconds");
        assert.strictEqual((yield* Fiber.join(fiber))._tag, "Success");
        assert.strictEqual(calls, 2);
        assert.strictEqual(fake.reads.timeline.length, read === "label events" ? 2 : 1);
        assert.strictEqual(fake.reads.labels, read === "label events" ? 0 : 2);
      }),
  );

  it.effect.each([Option.none<number>(), Option.some(502), Option.some(403)])(
    "retries bot-account lookup unless GitHub refuses it (%j)",
    (status) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let calls = 0;
        const fake = fakeGitHub({
          botAccount: Effect.suspend(() => {
            calls += 1;
            return calls === 1
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(
                    GitHubApiError.make({
                      operation: "read-bot-account",
                      status,
                      message: "Bot-account lookup failed",
                    }),
                  ),
                )
              : Effect.succeed(testBotAccount);
          }),
          timeline: () =>
            Effect.succeed([added(appActor, "ready-to-merge", at("2026-11-08T15:55:00Z"))]),
          labels: Effect.succeed([]),
        });
        const fiber = yield* verify(attemptOn("local"), review()).pipe(
          Effect.provide(fake.check),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        const refusal = Option.contains(status, 403);
        assert.strictEqual(result._tag, refusal ? "Failure" : "Success");
        assert.strictEqual(calls, refusal ? 1 : 2);
        assert.strictEqual(fake.reads.timeline.length, refusal ? 0 : 1);
        assert.strictEqual(fake.reads.labels, refusal ? 1 : 0);
      }),
  );

  it.effect("bounds bot-account lookup and retries timeouts before checking current labels", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let calls = 0;
      const fake = fakeGitHub({
        botAccount: Effect.suspend(() => {
          calls += 1;
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        }),
        timeline: () => Effect.die("A hung bot-account lookup cannot read the timeline"),
        labels: Effect.succeed(["ready-to-merge"]),
      });
      const fiber = yield* verify(attemptOn("local"), review()).pipe(
        Effect.provide(fake.check),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("14999 millis");
      assert.strictEqual(calls, 1);
      yield* TestClock.adjust("1000 millis");
      assert.strictEqual(calls, 1);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(calls, 2);
      yield* TestClock.adjust("32 seconds");
      assert.strictEqual((yield* Fiber.join(fiber))._tag, "Success");
      assert.strictEqual(calls, 3);
      assert.strictEqual(fake.reads.timeline.length, 0);
      assert.strictEqual(fake.reads.labels, 1);
    }),
  );

  it.effect.each(["label events", "current labels"] as const)(
    "allows 15 seconds per read before retrying timeouts on %s",
    (read) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const hung = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        const fake = fakeGitHub({
          timeline: () => (read === "label events" ? hung : Effect.fail(refused)),
          labels: read === "current labels" ? hung : Effect.succeed(["ready-to-merge"]),
        });
        const reads = () =>
          read === "label events" ? fake.reads.timeline.length : fake.reads.labels;
        const fiber = yield* verify(attemptOn("local"), review()).pipe(
          Effect.provide(fake.check),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("14999 millis");
        assert.strictEqual(reads(), 1);
        yield* TestClock.adjust("1000 millis");
        assert.strictEqual(reads(), 1);
        yield* TestClock.adjust("1 millis");
        assert.strictEqual(reads(), 2);
        yield* TestClock.adjust("32 seconds");
        const result = yield* Fiber.join(fiber);
        assert.strictEqual(result._tag, read === "label events" ? "Success" : "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure._tag, "AgentFailure");
          assert.include(result.failure.message, "Could not verify the loop's outcome labels");
        }
        assert.strictEqual(fake.reads.timeline.length, read === "label events" ? 3 : 1);
        assert.strictEqual(fake.reads.labels, read === "label events" ? 1 : 3);
      }),
  );
});

it.effect("the runtime composition verifies outcome labels against GitHub", () =>
  Effect.gen(function* () {
    const fake = fakeGitHub({ timeline: () => Effect.succeed([]) });
    const result = yield* verify(attemptOn("local"), review()).pipe(
      Effect.provide(engineItemChecksLayer(fake.github).pipe(Layer.provide(instanceLayer))),
    );
    assert(result._tag === "Failure");
    assert.include(result.failure.message, "added no outcome label");
    assert.strictEqual(fake.reads.timeline.length, 1);
  }),
);

it.live("settles a review whose outcome label the next loop removed before settlement", () => {
  // Seconds after the attempt started: the reviewer passes, replaces the pass with findings, and
  // the fix loop removes the findings label as it admits its Run, all before settlement (#1076).
  const fake = fakeGitHub({
    timeline: (since) => {
      const after = (seconds: number) => DateTime.add(since, { seconds });
      return Effect.succeed([
        added(appActor, "ready-to-merge", after(1)),
        removed(appActor, "ready-to-merge", after(2)),
        added(appActor, "agent-review-findings", after(2)),
        removed("octocat", "agent-review-findings", after(3)),
      ]);
    },
    labels: Effect.succeed([]),
  });
  const executions = { count: 0 };
  return withEngine(
    fake.check,
    executions,
    Effect.gen(function* () {
      const engine = yield* RunEngine;
      const accepted = yield* engine.submit(review());
      assert(accepted._tag === "Claimed");
      const finished = yield* waitFor(engine, accepted.runId, "Succeeded");
      assert.strictEqual(finished.attempts.length, 1);
      assert.strictEqual(executions.count, 1);
      assert.strictEqual(fake.reads.timeline.length, 1);
      assert.strictEqual(fake.reads.labels, 0);
    }),
  );
});

it.live("fails without re-running the agent when the attempt added no outcome label", () => {
  const fake = fakeGitHub({ timeline: () => Effect.succeed([]) });
  const executions = { count: 0 };
  return withEngine(
    fake.check,
    executions,
    Effect.gen(function* () {
      const engine = yield* RunEngine;
      const accepted = yield* engine.submit(review());
      assert(accepted._tag === "Claimed");
      const finished = yield* waitFor(engine, accepted.runId, "Failed");
      assert.strictEqual(finished.attempts.length, 1);
      assert.strictEqual(executions.count, 1);
      const outcome = finished.attempts[0]?.outcome;
      assert(outcome !== undefined && Option.isSome(outcome) && outcome.value._tag === "Failed");
      assert.strictEqual(outcome.value.failure._tag, "AgentFailure");
    }),
  );
});
