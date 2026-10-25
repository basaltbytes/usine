import { createHash } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { ConfigParser } from "@usine/config/parser";
import { IssueTrigger, PullRequestTrigger } from "@usine/config/trigger";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { QuestionFailure } from "@usine/core/attempt/failure";
import { CycleLimit } from "@usine/core/cycle-budget";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { RunReader, type RunSummary } from "@usine/engine/run-reader";
import { StepExecutor } from "@usine/engine/step-executor";
import { Source } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { GitHubItemHistory } from "@usine/github/item-history";
import { GitHubItemWriter } from "@usine/github/item-writer";
import {
  BaseRefName,
  ChangedIssue,
  ChangedPullRequest,
  ContentHash,
  GitHubPolling,
  IssueSnapshot,
  PullRequestSnapshot,
  RepositoryChanges,
  RepositoryLabelCatalog,
  type IssuePayload,
  type PullRequestPayload,
} from "@usine/github/polling";
import { DateTime, Effect, FileSystem, Layer, Option, Schedule, Schema } from "effect";
import { Operator } from "../src/operator/operator.ts";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import { ScheduleTriggers } from "../src/schedule-triggers.ts";
import { WorkerStatus } from "../src/worker-status.ts";
import {
  alwaysHoldsLayer,
  inertLabelReconcilerLayer,
  unmovedBaseRefHead,
} from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const developer = new AgentFile({
  name: AgentName.make("developer"),
  harness: "codex",
  model: ModelId.make("gpt-6-astra"),
  effort: "medium",
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Work on the Item."),
});
const startDev = (approval: "none" | "required") =>
  new LoopFile({
    name: LoopName.make("start-dev"),
    trigger: new IssueTrigger({
      on: "issue",
      if: Source.make(
        'item.state == "OPEN" && item.labels.nodes.exists(label, label.name == "ready-for-agent")',
      ),
    }),
    selector: Option.none(),
    approval,
    step: StepName.make("implement"),
    agent: developer.name,
    body: PromptTemplate.make("Implement issue {{ item.number }}."),
  });
const reviewPr = new LoopFile({
  name: LoopName.make("review-pr"),
  trigger: new PullRequestTrigger({
    on: "pr",
    if: Source.make(
      'item.state == "OPEN" && item.labels.nodes.exists(label, label.name == "ready-for-review")',
    ),
  }),
  selector: Option.none(),
  approval: "none",
  maxCycles: CycleLimit.make(1),
  step: StepName.make("review"),
  agent: developer.name,
  body: PromptTemplate.make("Review pull request {{ item.number }}."),
});
const fixPr = new LoopFile({
  name: LoopName.make("fix-pr"),
  trigger: new PullRequestTrigger({
    on: "pr",
    if: Source.make(
      'item.state == "OPEN" && item.labels.nodes.exists(label, label.name == "ready-for-fix")',
    ),
  }),
  selector: Option.none(),
  approval: "none",
  step: StepName.make("fix"),
  agent: developer.name,
  body: PromptTemplate.make("Fix pull request {{ item.number }}."),
});
const instanceWith = (loops: ReadonlyArray<LoopFile>) =>
  new LoadedInstance({
    config: Schema.decodeUnknownSync(UsineConfig)({ version: 1, repos: [{ name: repository }] }),
    agents: [developer],
    invalidAgents: [],
    quarantinedLoops: [],
    warnings: [],
    loops,
  });

/** An Item as the fake GitHub serves it; `round` stands for any content change, such as a push. */
interface GitHubItem {
  readonly kind: "issue" | "pr";
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly label: string;
  readonly round: number;
}

const issuePayload = (item: GitHubItem): IssuePayload => ({
  number: item.number,
  title: `Issue ${item.number}`,
  body: `Round ${item.round}.`,
  url: `https://github.com/${repository}/issues/${item.number}`,
  state: item.state === "OPEN" ? "OPEN" : "CLOSED",
  stateReason: item.state === "OPEN" ? null : "COMPLETED",
  createdAt: "2026-10-21T10:00:00Z",
  updatedAt: "2026-10-22T02:15:00Z",
  closedAt: item.state === "OPEN" ? null : "2026-10-22T02:15:00Z",
  author: { login: "operator" },
  issueType: null,
  milestone: null,
  labels: { totalCount: 1, nodes: [{ name: item.label }] },
  assignees: { totalCount: 0, nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
});

const pullRequestPayload = (item: GitHubItem): PullRequestPayload => ({
  number: item.number,
  title: `Pull request ${item.number}`,
  body: `Round ${item.round}.`,
  url: `https://github.com/${repository}/pull/${item.number}`,
  state: item.state,
  isDraft: false,
  merged: item.state === "MERGED",
  createdAt: "2026-10-21T10:00:00Z",
  updatedAt: "2026-10-22T02:15:00Z",
  mergedAt: item.state === "MERGED" ? "2026-10-22T02:15:00Z" : null,
  author: { login: "operator" },
  baseRefName: BaseRefName.make("main"),
  headRefName: `feature-${item.number}`,
  headRefOid: String(item.round).repeat(40),
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: null,
  labels: { totalCount: 1, nodes: [{ name: item.label }] },
  reviewRequests: { totalCount: 0, nodes: [] },
  reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { totalCount: 0, nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  closingIssuesReferences: { totalCount: 0, nodes: [] },
});

const contentHash = (item: GitHubItem) =>
  ContentHash.make(createHash("sha256").update(JSON.stringify(item)).digest("hex"));

/** Serves every Item in `items` as changed on each poll, with its current state. */
const fakeGitHub = (items: Map<number, GitHubItem>): GitHubPolling["Service"] => ({
  baseRefHead: unmovedBaseRefHead,
  missingIssues: () => Effect.succeed([]),
  labels: () =>
    Effect.succeed(new RepositoryLabelCatalog({ labels: [], entityTag: Option.none() })),
  changes: (_repository, cursor) =>
    Effect.gen(function* () {
      const updatedAt = yield* DateTime.now;
      return new RepositoryChanges({
        cursor,
        items: [...items.values()].map(({ kind, number }) =>
          kind === "pr"
            ? new ChangedPullRequest({ number, updatedAt })
            : new ChangedIssue({ number, updatedAt }),
        ),
        backlog: false,
        nextPollAt: Option.none(),
      });
    }),
  snapshot: (_repository, changed) =>
    Effect.gen(function* () {
      const item = items.get(changed.number);
      if (item === undefined) return yield* Effect.die(`no Item ${changed.number}`);
      return item.kind === "pr"
        ? new PullRequestSnapshot({
            payload: pullRequestPayload(item),
            contentHash: contentHash(item),
          })
        : new IssueSnapshot({ payload: issuePayload(item), contentHash: contentHash(item) });
    }),
});

const question = "Should this be fixed by pre-registering live Attempts?";

/** Lets every review-pr Attempt succeed and fails every other Attempt with a question. */
const executor = Layer.succeed(StepExecutor)({
  workers: Effect.succeed([WorkerName.make("local")]),
  isLive: () => Effect.succeed(false),
  outcome: () => Effect.succeed(Option.none()),
  recover: () => Effect.void,
  intervene: () => Effect.void,
  interrupt: () => Effect.void,
  occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
  sweep: Effect.void,
  reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
  execute: (execution) =>
    execution.run.loop === "review-pr"
      ? Effect.succeed(new StepResult({ message: "Reviewed", facts: [] }))
      : Effect.fail(new QuestionFailure({ question })),
});

/** Runs `test` against a real engine in a fresh instance folder, a fake GitHub, and the Operator. */
const withFactory = <A, E>(
  items: Map<number, GitHubItem>,
  test: Effect.Effect<A, E, Operator | PollingTriggers | CycleBudgets | RunReader>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fs.makeTempDirectoryScoped({ prefix: "usine-closed-items-" }),
    );
    const engine = localEngineLayer(directory).pipe(
      Layer.provide(executor),
      Layer.provide(alwaysHoldsLayer),
    );
    const dependencies = Layer.mergeAll(
      engine,
      MarcbachmannCelLayer,
      WorkerStatus.idle,
      ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer)),
      inertLabelReconcilerLayer,
      Layer.succeed(GitHubPolling, fakeGitHub(items)),
      Layer.succeed(GitHubItemWriter)({
        updateLabels: () => Effect.die("these tests move no Board cards"),
      }),
      Layer.succeed(GitHubItemHistory)({
        appChanges: () => Effect.die("these tests read no Item history"),
      }),
      Layer.succeed(ScheduleTriggers)({
        latest: Effect.succeed(Option.none()),
        run: () => Effect.never,
        tick: () => Effect.die("unused"),
      }),
    );
    const polling = PollingTriggers.layer.pipe(Layer.provideMerge(dependencies));
    return yield* test.pipe(Effect.provide(Operator.layer.pipe(Layer.provideMerge(polling))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Waits until every Run of the instance is closed and returns them. */
const settledRuns = Effect.gen(function* () {
  const reader = yield* RunReader;
  return yield* reader.list({ closedLimit: 100 }).pipe(
    Effect.repeat({
      until: (runs: ReadonlyArray<RunSummary>) =>
        runs.length > 0 && runs.every(({ closedAt }) => Option.isSome(closedAt)),
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.timeout("5 seconds"),
  );
});

const needTags = (instance: LoadedInstance) =>
  Effect.gen(function* () {
    const operator = yield* Operator;
    const overview = yield* operator.overview(instance);
    return overview.needsYou.map((need) => need._tag);
  });

/** Applies `change` to Item `number`, as a GitHub event would. */
const update = (items: Map<number, GitHubItem>, number: number, change: Partial<GitHubItem>) => {
  const item = items.get(number);
  assert(item !== undefined, `no Item ${number}`);
  items.set(number, { ...item, ...change });
};

describe("Items no Loop acts on", () => {
  it.live(
    "closes a merged pull request's cycle-budget Ask on the next poll and keeps its budget",
    () => {
      const items = new Map<number, GitHubItem>([
        [468, { kind: "pr", number: 468, state: "OPEN", label: "ready-for-review", round: 1 }],
      ]);
      const instance = instanceWith([reviewPr]);
      return withFactory(
        items,
        Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const budgets = yield* CycleBudgets;
          yield* polling.poll(instance);
          yield* settledRuns;
          update(items, 468, { round: 2 });
          const blocked = (yield* polling.poll(instance)).submissions[0];
          assert(blocked?._tag === "CycleBlocked");
          assert.deepStrictEqual(yield* needTags(instance), ["CycleBudgetNeed"]);
          update(items, 468, { state: "MERGED" });
          const merged = yield* polling.poll(instance);
          assert.deepStrictEqual(merged.submissions, []);
          assert.deepStrictEqual(yield* budgets.asks(), []);
          assert.deepStrictEqual(yield* needTags(instance), []);
          assert.strictEqual(yield* budgets.generation(gitHubItemKey(repository, 468)), 0);
          // The budget wasn't reset, so the reopened pull request is at its limit again.
          update(items, 468, { state: "OPEN" });
          const reopened = (yield* polling.poll(instance)).submissions[0];
          assert(reopened?._tag === "CycleBlocked");
          assert.deepStrictEqual(yield* needTags(instance), ["CycleBudgetNeed"]);
        }),
      );
    },
  );

  it.live(
    "leaves a closed issue's failed Run out of Needs attention and keeps the failure in the drawer",
    () => {
      const items = new Map<number, GitHubItem>([
        [177, { kind: "issue", number: 177, state: "OPEN", label: "ready-for-agent", round: 1 }],
      ]);
      const instance = instanceWith([startDev("none")]);
      return withFactory(
        items,
        Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const operator = yield* Operator;
          yield* polling.poll(instance);
          const [failed] = yield* settledRuns;
          assert(failed?.run.state._tag === "Failed");
          assert.deepStrictEqual(yield* needTags(instance), ["RunFailureNeed"]);
          assert.isNull((yield* operator.detail(instance, failed.run.id)).settledItemState);
          update(items, 177, { state: "CLOSED" });
          yield* polling.poll(instance);
          assert.deepStrictEqual(yield* needTags(instance), []);
          const detail = yield* operator.detail(instance, failed.run.id);
          assert.strictEqual(detail.settledItemState, "issue-closed");
          assert.isTrue(detail.run.canResolveFailure);
          assert.strictEqual(detail.run.attempts.at(-1)?.outcome?._tag, "Failed");
          const desk = yield* operator.desk(instance);
          assert.deepStrictEqual(
            desk.lastOutcomes.map(({ run }) => run.id),
            [failed.run.id],
          );
        }),
      );
    },
  );

  it.live(
    "gives a Project whose only failed Run is on a merged pull request no status or card ring",
    () => {
      const items = new Map<number, GitHubItem>([
        [470, { kind: "pr", number: 470, state: "OPEN", label: "ready-for-fix", round: 1 }],
      ]);
      const instance = instanceWith([fixPr]);
      return withFactory(
        items,
        Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const operator = yield* Operator;
          const attention = Effect.gen(function* () {
            const overview = yield* operator.overview(instance);
            const project = overview.projects[0];
            const card = project?.board.lanes
              .flatMap(({ items }) => items)
              .find(({ number }) => number === 470);
            const task = yield* operator.task(instance, repository, ItemNumber.make(470));
            return {
              status: project?.status,
              ring: card?.needsYou,
              taskNeedsYou: task.needsYou,
              needs: overview.needsYou.map((need) => need._tag),
            };
          });
          yield* polling.poll(instance);
          const [failed] = yield* settledRuns;
          assert(failed?.run.state._tag === "Failed");
          assert.deepStrictEqual(yield* attention, {
            status: "needs-you",
            ring: true,
            taskNeedsYou: true,
            needs: ["RunFailureNeed"],
          });
          update(items, 470, { state: "MERGED" });
          yield* polling.poll(instance);
          assert.deepStrictEqual(yield* attention, {
            status: "clear",
            ring: false,
            taskNeedsYou: false,
            needs: [],
          });
          const overview = yield* operator.overview(instance);
          const run = overview.projects[0]?.runs.find(({ id }) => id === failed.run.id);
          assert.isTrue(run?.canResolveFailure);
        }),
      );
    },
  );

  it.live(
    "revokes a waiting Run when its issue closes, so its approval leaves Needs attention",
    () => {
      const items = new Map<number, GitHubItem>([
        [74, { kind: "issue", number: 74, state: "OPEN", label: "ready-for-agent", round: 1 }],
      ]);
      const instance = instanceWith([startDev("required")]);
      return withFactory(
        items,
        Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const reader = yield* RunReader;
          const opened = (yield* polling.poll(instance)).submissions[0];
          assert(opened?._tag === "Claimed");
          assert.deepStrictEqual(yield* needTags(instance), ["ApprovalNeed"]);
          update(items, 74, { state: "CLOSED" });
          const closed = yield* polling.poll(instance);
          assert.strictEqual(closed.revokedRuns, 1);
          const revoked = yield* reader.inspect(opened.runId);
          assert(revoked.run.state._tag === "Canceled");
          assert.strictEqual(revoked.run.state.reason._tag, "Revoked");
          assert.deepStrictEqual(yield* needTags(instance), []);
        }),
      );
    },
  );

  it.live(
    "clears the 2026-10-22 Needs attention: two merged pull requests' Asks and a closed issue's question",
    () => {
      const items = new Map<number, GitHubItem>([
        [177, { kind: "issue", number: 177, state: "OPEN", label: "ready-for-agent", round: 1 }],
        [468, { kind: "pr", number: 468, state: "OPEN", label: "ready-for-review", round: 1 }],
        [469, { kind: "pr", number: 469, state: "OPEN", label: "ready-for-review", round: 1 }],
      ]);
      const instance = instanceWith([startDev("none"), reviewPr]);
      return withFactory(
        items,
        Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const budgets = yield* CycleBudgets;
          yield* polling.poll(instance);
          yield* settledRuns;
          for (const number of [468, 469]) update(items, number, { round: 2 });
          yield* polling.poll(instance);
          assert.deepStrictEqual([...(yield* needTags(instance))].sort(), [
            "CycleBudgetNeed",
            "CycleBudgetNeed",
            "RunFailureNeed",
          ]);
          for (const number of [468, 469]) update(items, number, { state: "MERGED" });
          update(items, 177, { state: "CLOSED" });
          yield* polling.poll(instance);
          assert.deepStrictEqual(yield* needTags(instance), []);
          assert.deepStrictEqual(yield* budgets.asks(), []);
        }),
      );
    },
  );
});
