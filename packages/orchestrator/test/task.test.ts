import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { AgentFailure } from "@usine/core/attempt/failure";
import { AttemptCanceled, AttemptFailed, AttemptSucceeded } from "@usine/core/attempt/outcome";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import { RepositoryName } from "@usine/core/repository";
import { Run, RunId } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import * as RunState from "@usine/core/run/state";
import { Step, StepName } from "@usine/core/step";
import { Comment, PullRequest, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionReader,
  ItemProjectionSource,
} from "@usine/engine/item-projection";
import { UnconfirmedStops } from "@usine/engine/engine";
import { LoopControl } from "@usine/engine/loop-control";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { RunEvent, RunReader, RunSummary } from "@usine/engine/run-reader";
import { DateTime, Effect, Layer, Option, Ref, Schema } from "effect";
import { OperatorObservation } from "../src/operator/operator.ts";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import { ScheduleTriggers } from "../src/schedule-triggers.ts";
import { WorkerStatus } from "../src/worker-status.ts";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { noCycleBudgets } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const brain = new BrainSpec({
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
});
const developer = new Agent({
  name: AgentName.make("developer"),
  brain,
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Build it."),
});

const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [
    {
      name: repository,
      lanes: [
        { name: "Ready", sources: [{ label: "ready" }] },
        { name: "In review", sources: [{ label: "ready-for-review" }, { state: "pr-open" }] },
        { name: "Done", sources: [{ state: "issue-closed" }, { state: "pr-merged" }] },
      ],
    },
  ],
});
const instance = new LoadedInstance({
  config,
  agents: [],
  invalidAgents: [],
  loops: [],
  quarantinedLoops: [],
  warnings: [],
});

const at = (iso: string) => DateTime.makeUnsafe(iso);
const pullUrl = (number: number) => `https://github.com/${repository}/pull/${number}`;

const issue = (number: number, title: string, closingPullRequests: ReadonlyArray<number> = []) =>
  new ItemProjection({
    itemKey: gitHubItemKey(repository, number),
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`issue-${number}`),
    payload: {
      number,
      title,
      body: "",
      url: `https://github.com/${repository}/issues/${number}`,
      state: "OPEN",
      stateReason: null,
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
      closedAt: null,
      author: { login: "PhilDL" },
      issueType: null,
      milestone: null,
      labels: { totalCount: 1, nodes: [{ name: "bug" }] },
      assignees: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closedByPullRequestsReferences: {
        totalCount: closingPullRequests.length,
        nodes: closingPullRequests.map((pr) => ({
          number: pr,
          state: "OPEN",
          isDraft: false,
          url: pullUrl(pr),
        })),
      },
    },
  });

const pullRequest = (
  number: number,
  title: string,
  state: { readonly merged: boolean; readonly mergeable: string },
) =>
  new ItemProjection({
    itemKey: gitHubItemKey(repository, number),
    repository,
    source: ItemProjectionSource.make("pr"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`pr-${number}`),
    payload: {
      number,
      title,
      body: "",
      url: pullUrl(number),
      state: state.merged ? "MERGED" : "OPEN",
      isDraft: false,
      merged: state.merged,
      createdAt: "2026-10-02T10:00:00Z",
      updatedAt: "2026-10-02T10:00:00Z",
      mergedAt: state.merged ? "2026-10-03T10:00:00Z" : null,
      author: { login: "usine-bot" },
      baseRefName: "main",
      headRefName: `fix/${number}`,
      headRefOid: "410607d",
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      reviewDecision: null,
      mergeable: state.mergeable,
      mergeStateStatus: "UNKNOWN",
      statusCheckRollup: null,
      labels: { totalCount: 1, nodes: [{ name: "ready-for-review" }] },
      reviewRequests: { totalCount: 0, nodes: [] },
      reviews: { totalCount: 0, nodes: [] },
      reviewThreads: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closingIssuesReferences: { totalCount: 0, nodes: [] },
    },
  });

const attempt = (
  runId: RunId,
  number: number,
  startedAt: string,
  outcome: Attempt["outcome"],
  endedAt: Option.Option<string>,
) =>
  new Attempt({
    id: AttemptId.make(`${runId}/${number}`),
    runId,
    stepName: StepName.make("run"),
    number: AttemptNumber.make(number),
    worker: WorkerName.make("local"),
    brain,
    parentModel: Option.none(),
    task: AttemptTask.make("Do the work."),
    agent: developer.name,
    operatorIntervened: false,
    startedAt: at(startedAt),
    outcome,
    endedAt: Option.map(endedAt, at),
    salvage: Option.none(),
  });

const summary = (
  id: string,
  item: number,
  loop: string,
  state: RunState.RunState,
  openedAt: string,
  attempts: (runId: RunId) => ReadonlyArray<Attempt>,
  result: Option.Option<StepResult> = Option.none(),
  runAgain: Option.Option<RunAgain> = Option.none(),
) => {
  const runId = RunId.make(id);
  return new RunSummary({
    itemKey: gitHubItemKey(repository, item),
    run: new Run({
      id: runId,
      eventId: EventId.make(`event-${id}`),
      loop: LoopName.make(loop),
      state,
      openedAt: at(openedAt),
    }),
    step: new Step({ runId, name: StepName.make("run"), result }),
    attempts: attempts(runId),
    resolvedFailureAttemptId: Option.none(),
    closedAt: Option.none(),
    approval: Option.none(),
    runAgain,
    repository,
    task: AttemptTask.make("Do the work."),
    agent: developer,
  });
};

const succeeded = Option.some(new AttemptSucceeded());

/**
 * Issue #40 with PR #41, linked by the plan Run's result, and PR #42, linked by the issue's closing
 * reference. Issue #50 has no links.
 */
const items = [
  pullRequest(42, "Fix the flaky reader test", { merged: false, mergeable: "CONFLICTING" }),
  pullRequest(41, "Plan the reader rework", { merged: true, mergeable: "UNKNOWN" }),
  issue(50, "Unrelated issue"),
  issue(40, "Rework the reader", [42]),
];

const runs = [
  summary(
    "run-plan",
    40,
    "plan",
    new RunState.Succeeded(),
    "2026-10-02T09:00:00.000Z",
    (runId) => [
      attempt(
        runId,
        1,
        "2026-10-02T09:00:00.000Z",
        succeeded,
        Option.some("2026-10-02T09:20:00.000Z"),
      ),
    ],
    Option.some(
      new StepResult({
        message: "Opened the plan.",
        facts: [
          new PullRequest({ number: 41, url: new URL(pullUrl(41)) }),
          new Comment({
            url: new URL(`https://github.com/${repository}/issues/40#issuecomment-1`),
            kind: "issue-comment",
            at: Option.none(),
          }),
        ],
      }),
    ),
  ),
  summary(
    "run-dev",
    40,
    "start-dev",
    new RunState.Failed(),
    "2026-10-03T09:00:00.000Z",
    (runId) => [
      attempt(
        runId,
        1,
        "2026-10-03T09:00:00.000Z",
        Option.some(new AttemptFailed({ failure: new AgentFailure({ message: "Checks failed" }) })),
        Option.some("2026-10-03T09:30:00.000Z"),
      ),
      new Attempt({
        ...attempt(
          runId,
          2,
          "2026-10-03T10:00:00.000Z",
          Option.some(
            new AttemptFailed({ failure: new AgentFailure({ message: "Checks failed" }) }),
          ),
          Option.some("2026-10-03T10:30:00.000Z"),
        ),
        // A failed Attempt keeps the comments it posted on the Attempt itself.
        comments: [
          new Comment({
            url: new URL(`https://github.com/${repository}/issues/40#issuecomment-2`),
            kind: "issue-comment",
            at: Option.some(at("2026-10-03T10:10:00.000Z")),
          }),
        ],
      }),
    ],
  ),
  summary(
    "run-review",
    41,
    "review-pr",
    new RunState.Succeeded(),
    "2026-10-04T09:00:00.000Z",
    (runId) => [
      attempt(
        runId,
        1,
        "2026-10-04T09:00:00.000Z",
        succeeded,
        Option.some("2026-10-04T09:12:00.000Z"),
      ),
    ],
    Option.some(
      new StepResult({
        message: "Reviewed.",
        facts: [
          new Comment({
            url: new URL(`${pullUrl(41)}#pullrequestreview-7`),
            kind: "review",
            at: Option.some(DateTime.makeUnsafe("2026-10-04T09:05:00.000Z")),
          }),
          new Comment({
            url: new URL(`${pullUrl(41)}#discussion_r8`),
            kind: "review-comment",
            at: Option.none(),
          }),
        ],
      }),
    ),
  ),
  summary(
    "run-fix",
    42,
    "fix-ci",
    new RunState.Canceled({ reason: new RunState.OperatorCanceled() }),
    "2026-10-05T09:00:00.000Z",
    (runId) => [
      attempt(
        runId,
        1,
        "2026-10-05T09:00:00.000Z",
        Option.some(new AttemptCanceled()),
        Option.some("2026-10-05T09:05:00.000Z"),
      ),
    ],
  ),
  summary(
    "run-fix-again",
    42,
    "fix-ci",
    new RunState.Running(),
    "2026-10-06T09:00:00.000Z",
    (runId) => [attempt(runId, 1, "2026-10-06T09:01:00.000Z", Option.none(), Option.none())],
    Option.none(),
    Option.some(
      new RunAgain({
        from: RunId.make("run-fix"),
        requestedBy: Option.some(OperatorLogin.make("PhilDL")),
      }),
    ),
  ),
  summary(
    "run-other",
    50,
    "triage",
    new RunState.Succeeded(),
    "2026-10-07T09:00:00.000Z",
    () => [],
  ),
];

const observation = (
  requested: Ref.Ref<ReadonlyArray<string>>,
  runEvents: ReadonlyArray<RunEvent> = [],
) => {
  const reader = Layer.succeed(RunReader)({
    inspect: () => Effect.die("unused"),
    evidence: () => Effect.die("unused"),
    list: () => Effect.die("A Task reads every Run of its Items, not the overview's window"),
    closed: () => Effect.die("unused"),
    forItems: (keys) =>
      Ref.set(requested, keys).pipe(
        Effect.as(runs.filter(({ itemKey }) => keys.includes(itemKey))),
      ),
    events: (runIds) => Effect.succeed(runEvents.filter(({ runId }) => runIds.includes(runId))),
    revision: () => Effect.succeed(Option.none()),
    transcript: () => Effect.die("unused"),
    attemptsByWorker: () => Effect.succeed([]),
    sightings: () => Effect.die("A Task reads no Loop sightings"),
  });
  const controls = Layer.succeed(LoopControl)({
    isPaused: () => Effect.succeed(false),
    pause: () => Effect.die("unused"),
    unpause: () => Effect.die("unused"),
    states: Effect.succeed([]),
  });
  const itemReader = Layer.succeed(ItemProjectionReader)({
    get: () => Effect.die("the Task read reads no single Item"),
    list: () => Effect.succeed(items),
    openIssues: () => Effect.die("the Task read does not check open issues"),
  });
  const labels = Layer.succeed(RepositoryLabelProjectionReader)({
    get: () => Effect.succeed(Option.none()),
  });
  const polling = Layer.succeed(PollingTriggers)({
    hint: () => Effect.die("unused"),
    poll: () => Effect.die("unused"),
    run: () => Effect.never,
    latest: Effect.succeed(Option.none()),
  });
  const schedules = Layer.succeed(ScheduleTriggers)({
    tick: () => Effect.die("unused"),
    run: () => Effect.never,
    latest: Effect.succeed(Option.none()),
  });
  return OperatorObservation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        noCycleBudgets,
        reader,
        controls,
        itemReader,
        labels,
        polling,
        schedules,
        MarcbachmannCelLayer,
        WorkerStatus.idle,
        UnconfirmedStops.empty,
      ),
    ),
  );
};

const readTask = (
  number: number,
  project: RepositoryName = repository,
  runEvents: ReadonlyArray<RunEvent> = [],
) =>
  Effect.gen(function* () {
    const requested = yield* Ref.make<ReadonlyArray<string>>([]);
    const task = yield* Effect.gen(function* () {
      const operator = yield* OperatorObservation;
      return yield* operator.task(instance, project, ItemNumber.make(number));
    }).pipe(Effect.provide(observation(requested, runEvents)));
    return { task, requested: yield* Ref.get(requested) };
  });

describe("Task view", () => {
  it.effect("joins an issue and its two pull requests with every Run on them, newest first", () =>
    Effect.gen(function* () {
      const { task, requested } = yield* readTask(40);
      assert.strictEqual(task.number, 40);
      assert.strictEqual(task.title, "Rework the reader");
      assert.deepStrictEqual(
        task.items.map(({ kind, number, state, conflicting }) => [
          kind,
          number,
          state,
          conflicting,
        ]),
        [
          ["issue", 40, "issue-open", false],
          ["pr", 41, "pr-merged", false],
          ["pr", 42, "pr-open", true],
        ],
      );
      // The open Run on #42 puts the Task in the lane its pull request routes to.
      assert.strictEqual(task.current, gitHubItemKey(repository, 42));
      assert.strictEqual(task.lane.name, "In review");
      assert.deepStrictEqual(
        task.runs.map(({ id, state }) => [id, state]),
        [
          ["run-fix-again", "Running"],
          ["run-fix", "Canceled"],
          ["run-review", "Succeeded"],
          ["run-dev", "Failed"],
          ["run-plan", "Succeeded"],
        ],
      );
      assert.strictEqual(task.runs[0]?.runAgain?.from, "run-fix");
      assert.isTrue(task.needsYou);
      // A comment has GitHub's time if the harvest recorded one, and always its Attempt's end; a
      // Run's comments are newest first by the time they have.
      assert.deepStrictEqual(
        task.comments.map(({ runId, kind, postedAt, attemptEndedAt }) => [
          runId,
          kind,
          postedAt,
          attemptEndedAt,
        ]),
        [
          ["run-review", "review-comment", null, "2026-10-04T09:12:00.000Z"],
          ["run-review", "review", "2026-10-04T09:05:00.000Z", "2026-10-04T09:12:00.000Z"],
          ["run-dev", "issue-comment", "2026-10-03T10:10:00.000Z", "2026-10-03T10:30:00.000Z"],
          ["run-plan", "issue-comment", null, "2026-10-02T09:20:00.000Z"],
        ],
      );
      // Run histories come from every Item the Board considers, not the overview's recent window.
      assert.strictEqual(requested.length, items.length);
    }),
  );

  it.effect("finds the same Task from any of its Items and names the originating issue", () =>
    Effect.gen(function* () {
      const { task } = yield* readTask(42);
      assert.strictEqual(task.number, 40);
      assert.strictEqual(task.items.length, 3);
    }),
  );

  it.effect("shows an Item without linked pull requests as a Task of its own", () =>
    Effect.gen(function* () {
      const { task } = yield* readTask(50);
      assert.deepStrictEqual(
        task.items.map(({ number }) => number),
        [50],
      );
      assert.deepStrictEqual(
        task.runs.map(({ id }) => id),
        ["run-other"],
      );
      assert.deepStrictEqual(task.comments, []);
      assert.isFalse(task.needsYou);
    }),
  );

  it.effect("names the lane its running Run was triggered from as the Board does", () =>
    Effect.gen(function* () {
      // fix-ci was triggered while #42 had `ready`; it has `ready-for-review` now.
      const triggered = new RunEvent({
        runId: RunId.make("run-fix-again"),
        event: new Event({
          id: EventId.make("event-run-fix-again"),
          dedupKey: DedupKey.make("event-run-fix-again"),
          payload: { number: 42, labels: { totalCount: 1, nodes: [{ name: "ready" }] } },
          receivedAt: at("2026-10-06T08:59:00.000Z"),
        }),
      });
      const { task } = yield* readTask(40, repository, [triggered]);
      assert.strictEqual(task.current, gitHubItemKey(repository, 42));
      assert.strictEqual(task.lane.name, "Ready");
    }),
  );

  it.effect("refuses an Item outside the Board and a repository that is not a Project", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(readTask(99));
      assert.strictEqual(missing._tag, "BoardItemNotFoundError");
      const elsewhere = yield* Effect.flip(readTask(40, RepositoryName.make("someone/else")));
      assert.strictEqual(elsewhere._tag, "BoardProjectNotFoundError");
    }),
  );
});
