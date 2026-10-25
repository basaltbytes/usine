import { assert, describe, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/config/label";
import { LabelLaneSource, LaneName } from "@usine/config/board";
import { UsineConfig } from "@usine/config/factory";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  type BillingPool,
  ParentSession,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { ItemKey, ItemNumber as CoreItemNumber, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
} from "@usine/engine/item-projection";
import { DateTime, Effect, Option, Schema } from "effect";
import { labelMutationForBoardMove, projectBoard } from "../src/board/projection.ts";
import {
  BoardTaskView,
  BoardItemLink,
  BoardLaneId,
  BoardPullRequestView,
  BoardView,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
} from "../src/operator/board.ts";
import { SucceededAttemptView } from "../src/operator/attempt.ts";
import { RunView } from "../src/operator/run.ts";
import {
  PoolUsageView,
  RunUsageView,
  SessionUsageView,
  taskUsage,
  UsageCostView,
} from "../src/operator/usage.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = ItemKey.make("github:basaltbytes/usine:33");
const ready = GitHubLabelName.make("ready-for-agent");
const review = GitHubLabelName.make("ready-for-review");
const bug = GitHubLabelName.make("bug");
const reviewLane = LaneName.make("ready-for-review");
const itemWithLabels = (labels: ReadonlyArray<GitHubLabelName>) =>
  new ItemProjection({
    itemKey,
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(33),
    contentHash: ItemContentHash.make(`issue-33:${labels.join(",")}`),
    payload: {
      number: 33,
      title: "Board lanes",
      body: "Build the Board.",
      url: "https://github.com/basaltbytes/usine/issues/33",
      state: "OPEN",
      stateReason: null,
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-01T12:00:00Z",
      closedAt: null,
      author: { login: "PhilDL" },
      issueType: null,
      milestone: null,
      labels: {
        totalCount: labels.length,
        nodes: labels.map((name) => ({ name })),
      },
      assignees: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
    },
  });

const item = itemWithLabels([ready, bug]);
const closedItem = new ItemProjection({
  ...itemWithLabels([ready]),
  contentHash: ItemContentHash.make("issue-33:closed"),
  payload: {
    ...itemWithLabels([ready]).payload,
    state: "CLOSED",
    stateReason: "COMPLETED",
    closedAt: "2026-09-03T08:00:00Z",
  },
});

const passed = GitHubLabelName.make("review-passed");
const mergedPullRequest = new ItemProjection({
  itemKey: ItemKey.make("github:basaltbytes/usine:98"),
  repository,
  source: ItemProjectionSource.make("pr"),
  number: ItemNumber.make(98),
  contentHash: ItemContentHash.make("pr-98:merged"),
  payload: {
    number: 98,
    title: "Isolate Turbo from bare caches",
    body: "Closes #84.",
    url: "https://github.com/basaltbytes/usine/pull/98",
    state: "MERGED",
    isDraft: false,
    merged: true,
    createdAt: "2026-09-02T18:00:00Z",
    updatedAt: "2026-09-03T08:00:00Z",
    mergedAt: "2026-09-03T08:00:00Z",
    author: { login: "usine-bot" },
    baseRefName: "main",
    headRefName: "fix/issue-84-bare-cache-sweep",
    headRefOid: "410607d",
    additions: 40,
    deletions: 12,
    changedFiles: 3,
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: { state: "SUCCESS" },
    labels: { totalCount: 1, nodes: [{ name: passed }] },
    reviewRequests: { totalCount: 0, nodes: [] },
    reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    closingIssuesReferences: { totalCount: 1, nodes: [{ number: 84, state: "CLOSED" }] },
  },
});

const runForBoard = (id: string, state: "Waiting" | "Running" | "Failed" | "Succeeded") =>
  new RunView({
    id: RunId.make(id),
    itemKey,
    loop: LoopName.make(`loop-${id}`),
    repository,
    agent: AgentName.make("developer"),
    state,
    loopPaused: false,
    openedAt: "2026-09-01T12:00:00.000Z",
    closedAt: state === "Failed" || state === "Succeeded" ? "2026-09-01T12:30:00.000Z" : null,
    task: "Build the Board.",
    attempts: [],
    approval: null,
    runAgain: null,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: state === "Waiting",
    canRetry: state === "Failed",
    canResolveFailure: state === "Failed",
    canCancel: state === "Waiting" || state === "Running",
    canRunAgain: false,
  });

describe("Board projection", () => {
  it.effect("gives label lanes precedence over state lanes", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [
          {
            name: repository,
            lanes: [
              { name: "Open", sources: [{ state: "issue-open" }] },
              { name: "Ready", sources: [{ label: ready }] },
            ],
          },
        ],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const board = yield* projectBoard(managed, [], [item], []);
      assert.strictEqual(board.lanes[0]?.items.length, 0);
      assert.strictEqual(board.lanes[1]?.items[0]?.itemKey, itemKey);
      assert.deepStrictEqual(board.failures, []);
    }),
  );

  it.effect("matches lane labels ignoring case, as GitHub does", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [
          { name: repository, lanes: [{ name: "Ready", sources: [{ label: "Ready-For-Agent" }] }] },
        ],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const board = yield* projectBoard(managed, [], [item], []);
      assert.strictEqual(board.lanes[0]?.items[0]?.itemKey, itemKey);
    }),
  );

  it.effect("groups a merged pull request by state even when it still carries a lane label", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [
          {
            name: repository,
            lanes: [
              { name: "Passed", sources: [{ label: passed }] },
              { name: "Done", sources: [{ state: "pr-merged" }] },
            ],
          },
        ],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const board = yield* projectBoard(managed, [], [mergedPullRequest], []);
      assert.deepStrictEqual(board.lanes[0]?.items, []);
      assert.strictEqual(board.lanes[1]?.items[0]?.itemKey, mergedPullRequest.itemKey);
      assert.deepStrictEqual(board.failures, []);
    }),
  );

  it.effect(
    "leaves a closed issue, or an open one GitHub no longer has, unmapped instead of placing it by a leftover label",
    () =>
      Effect.gen(function* () {
        const config = Schema.decodeUnknownSync(UsineConfig)({
          version: 1,
          repos: [{ name: repository, lanes: [{ name: "Ready", sources: [{ label: ready }] }] }],
        });
        const managed = config.repos[0];
        assert(managed !== undefined);
        const gone = new ItemProjection({
          ...itemWithLabels([ready]),
          goneAt: Option.some(DateTime.makeUnsafe("2026-09-04T08:00:00Z")),
        });
        for (const settled of [closedItem, gone]) {
          const board = yield* projectBoard(managed, [], [settled], []);
          assert.deepStrictEqual(board.lanes[0]?.items, []);
          const unmapped = board.lanes.find(({ origin }) => origin === "fallback");
          assert.strictEqual(unmapped?.items[0]?.itemKey, itemKey);
          assert.strictEqual(unmapped?.items[0]?.state, "issue-closed");
        }
      }),
  );

  it.effect("moves an open pull request GitHub no longer has to its closed lane", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [
          {
            name: repository,
            lanes: [
              { name: "Open", sources: [{ state: "pr-open" }] },
              { name: "Review", sources: [{ label: review }] },
              { name: "Closed", sources: [{ state: "pr-closed" }] },
            ],
          },
        ],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const open = new ItemProjection({
        ...mergedPullRequest,
        contentHash: ItemContentHash.make("pr-98:open"),
        payload: {
          ...mergedPullRequest.payload,
          state: "OPEN",
          merged: false,
          mergedAt: null,
          labels: { totalCount: 1, nodes: [{ name: review }] },
        },
      });
      const gone = new ItemProjection({
        ...open,
        goneAt: Option.some(DateTime.makeUnsafe("2026-09-04T08:00:00Z")),
      });
      const before = yield* projectBoard(managed, [], [open], []);
      assert.strictEqual(before.lanes[1]?.items[0]?.itemKey, open.itemKey);
      assert.strictEqual(before.lanes[1]?.items[0]?.pullRequest?.state, "pr-open");
      const board = yield* projectBoard(managed, [], [gone], []);
      assert.deepStrictEqual(board.lanes[0]?.items, []);
      assert.deepStrictEqual(board.lanes[1]?.items, []);
      assert.strictEqual(board.lanes[2]?.items[0]?.itemKey, gone.itemKey);
      assert.strictEqual(board.lanes[2]?.items[0]?.state, "pr-closed");
      // A pull request closed without merging is not the Task's pull request.
      assert.strictEqual(board.lanes[2]?.items[0]?.pullRequest, null);
    }),
  );

  it.effect("proposes lanes from unused repository labels when there are no Items", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const board = yield* projectBoard(managed, [review, bug], [], []);
      assert.deepStrictEqual(
        board.lanes.map(({ name }) => name),
        [bug, review, "Unmapped"],
      );
    }),
  );

  it.effect("quarantines one malformed Item projection and keeps its sibling", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository, lanes: [{ name: "Ready", sources: [{ label: ready }] }] }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const malformed = new ItemProjection({
        itemKey: ItemKey.make("github:basaltbytes/usine:34"),
        repository,
        source: ItemProjectionSource.make("issue"),
        number: ItemNumber.make(34),
        contentHash: ItemContentHash.make("malformed-34"),
        payload: { number: 34 },
      });
      const board = yield* projectBoard(managed, [], [malformed, item], []);
      assert.strictEqual(board.lanes[0]?.items[0]?.itemKey, itemKey);
      assert.strictEqual(board.failures.length, 1);
      assert.strictEqual(board.failures[0]?.itemKey, malformed.itemKey);
    }),
  );

  it.effect("keeps every actionable Run while preferring it over a settled Run", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository, lanes: [{ name: "Ready", sources: [{ label: ready }] }] }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const waiting = runForBoard("waiting-run", "Waiting");
      const succeeded = runForBoard("newer-succeeded-run", "Succeeded");
      const board = yield* projectBoard(managed, [], [item], [succeeded, waiting]);
      const card = board.lanes[0]?.items[0];
      assert.strictEqual(card?.run?.id, waiting.id);
      assert.strictEqual(card?.needsYou, true);
      assert.deepStrictEqual(
        card?.runs.map(({ id }) => id),
        [succeeded.id, waiting.id],
      );
    }),
  );

  it.effect("retains a Waiting and Failed Run when another Run is active", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository, lanes: [{ name: "Ready", sources: [{ label: ready }] }] }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const running = runForBoard("running-run", "Running");
      const waiting = runForBoard("waiting-run", "Waiting");
      const failed = runForBoard("failed-run", "Failed");
      const board = yield* projectBoard(managed, [], [item], [running, waiting, failed]);
      const card = board.lanes[0]?.items[0];
      assert.strictEqual(card?.run?.id, waiting.id);
      assert.strictEqual(card?.needsYou, true);
      assert.deepStrictEqual(
        card?.runs.map(({ id }) => id),
        [failed.id, running.id, waiting.id],
      );
    }),
  );

  it.effect("prefers the active Run over a failed Run on a closed issue, which needs no one", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository, lanes: [{ name: "Review", sources: [{ label: review }] }] }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const pr = new ItemProjection({
        ...mergedPullRequest,
        payload: {
          ...mergedPullRequest.payload,
          state: "OPEN",
          merged: false,
          mergedAt: null,
          labels: { totalCount: 1, nodes: [{ name: review }] },
        },
      });
      const failed = new RunView({
        ...runForBoard("failed-run", "Failed"),
        pullRequestUrl: "https://github.com/basaltbytes/usine/pull/98",
      });
      const reviewRun = new RunView({
        ...runForBoard("review-run", "Running"),
        itemKey: pr.itemKey,
        openedAt: "2026-09-01T11:00:00.000Z",
      });
      const board = yield* projectBoard(managed, [], [closedItem, pr], [failed, reviewRun]);
      const card = board.lanes.flatMap(({ items }) => items)[0];
      assert.strictEqual(card?.run?.id, reviewRun.id);
      assert.strictEqual(card?.needsYou, false);
    }),
  );

  it.effect(
    "keeps issue development and PR review in one Task after the issue loses its label",
    () =>
      Effect.gen(function* () {
        const config = Schema.decodeUnknownSync(UsineConfig)({
          version: 1,
          repos: [{ name: repository, lanes: [{ name: "Review", sources: [{ label: review }] }] }],
        });
        const managed = config.repos[0];
        assert(managed !== undefined);
        const pr = new ItemProjection({
          ...mergedPullRequest,
          payload: {
            ...mergedPullRequest.payload,
            state: "OPEN",
            merged: false,
            mergedAt: null,
            mergeable: "CONFLICTING",
            mergeStateStatus: "DIRTY",
            labels: { totalCount: 1, nodes: [{ name: review }] },
          },
        });
        const development = new RunView({
          ...runForBoard("development", "Succeeded"),
          pullRequestUrl: "https://github.com/basaltbytes/usine/pull/98",
        });
        const reviewRun = new RunView({
          ...runForBoard("review", "Running"),
          itemKey: pr.itemKey,
          openedAt: "2026-09-02T12:00:00.000Z",
        });
        const develop = LoopName.make("start-dev");
        const reviewLoop = LoopName.make("review-pr");
        const board = yield* projectBoard(
          managed,
          [],
          [itemWithLabels([]), pr],
          [reviewRun, development],
          [itemKey],
          new Map([
            [pr.itemKey, [reviewLoop]],
            [itemKey, [develop, reviewLoop]],
          ]),
        );
        const card = board.lanes[0]?.items[0];
        assert(card !== undefined);
        // Each Loop matching one of the Task's Items appears once, the issue's Loops first.
        assert.deepStrictEqual(card.loops, [develop, reviewLoop]);
        assert.strictEqual(card.title, "Board lanes");
        assert.strictEqual(card.itemKey, pr.itemKey);
        assert.deepStrictEqual(
          card.pullRequest,
          new BoardPullRequestView({
            number: ItemNumber.make(98),
            url: "https://github.com/basaltbytes/usine/pull/98",
            state: "pr-open",
          }),
        );
        assert.deepStrictEqual(
          card.items.map(({ number }) => number),
          [33, 98],
        );
        assert.deepStrictEqual(
          card.runs.map(({ id }) => id),
          [development.id, reviewRun.id],
        );
        assert.strictEqual(card.needsYou, true);
        assert.strictEqual(card.conflicting, true);
        assert.strictEqual(board.lanes.at(-1)?.items.length, 0);
      }),
  );

  it.effect("joins only canonical same-repository closing links without Runs", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      for (const [url, count] of [
        ["https://github.com/basaltbytes/usine/pull/98", 1],
        ["https://github.com/another/repository/pull/98", 2],
        ["https://github.com/basaltbytes/usine/pull/0x62", 2],
        ["https://github.com/basaltbytes/usine/pull/9.8e1", 2],
      ] as const) {
        const linked = new ItemProjection({
          ...closedItem,
          payload: {
            ...closedItem.payload,
            closedByPullRequestsReferences: {
              totalCount: 1,
              nodes: [{ number: 98, url, state: "MERGED", isDraft: false }],
            },
          },
        });
        const board = yield* projectBoard(managed, [], [linked, mergedPullRequest], []);
        assert.strictEqual(board.failures.length, 0);
        assert.strictEqual(board.lanes.flatMap(({ items }) => items).length, count);
      }
    }),
  );

  it.effect("groups several issues sharing a PR once, independently of snapshot order", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const issue34 = new ItemProjection({
        ...item,
        itemKey: ItemKey.make("github:basaltbytes/usine:34"),
        number: ItemNumber.make(34),
        payload: {
          ...item.payload,
          number: 34,
          title: "Companion issue",
          url: "https://github.com/basaltbytes/usine/issues/34",
        },
      });
      const development = new RunView({
        ...runForBoard("dev-33", "Succeeded"),
        pullRequestUrl: "https://github.com/basaltbytes/usine/pull/98",
      });
      const companion = new RunView({
        ...development,
        id: RunId.make("dev-34"),
        itemKey: issue34.itemKey,
      });
      const reviewRun = new RunView({
        ...runForBoard("review-98", "Running"),
        itemKey: mergedPullRequest.itemKey,
      });
      for (const snapshots of [
        [item, issue34, mergedPullRequest],
        [mergedPullRequest, issue34, item],
      ]) {
        const board = yield* projectBoard(managed, [], snapshots, [
          development,
          companion,
          reviewRun,
        ]);
        const cards = board.lanes.flatMap(({ items }) => items);
        assert.strictEqual(cards.length, 1);
        const card = cards[0];
        assert(card !== undefined);
        assert.strictEqual(card.title, "Board lanes");
        assert.deepStrictEqual(
          card.items.map(({ number }) => number),
          [33, 34, 98],
        );
        assert.strictEqual(card.itemKey, mergedPullRequest.itemKey);
        assert.strictEqual(card.pullRequest?.state, "pr-merged");
        assert.deepStrictEqual(
          card.runs.map(({ id }) => id),
          [development.id, companion.id, reviewRun.id],
        );
      }
    }),
  );

  it("derives an authored lane mutation without trusting truncated card labels", () => {
    const card = new BoardTaskView({
      itemKey,
      kind: "issue",
      number: CoreItemNumber.make(33),
      title: "Board lanes",
      url: "https://github.com/basaltbytes/usine/issues/33",
      state: "issue-open",
      items: [
        new BoardItemLink({
          itemKey,
          kind: "issue",
          number: ItemNumber.make(33),
          title: "Board lanes",
          url: "https://github.com/basaltbytes/usine/issues/33",
          state: "issue-open",
        }),
      ],
      labels: [bug],
      pullRequest: null,
      runs: [],
      run: null,
      needsYou: false,
      conflicting: false,
      loops: [],
      usage: taskUsage([], new Map()),
    });
    const source = new WritableBoardLaneView({
      id: BoardLaneId.make("authored:Ready"),
      name: LaneName.make("Ready"),
      sources: [new LabelLaneSource({ label: ready })],
      labels: [ready],
      origin: "authored",
      items: [card],
    });
    const target = new WritableBoardLaneView({
      id: BoardLaneId.make("authored:Review"),
      name: LaneName.make("Review"),
      sources: [new LabelLaneSource({ label: review })],
      labels: [review],
      origin: "authored",
      items: [],
    });
    const board = new BoardView({
      failures: [],
      lanes: [
        source,
        target,
        new ReadOnlyBoardLaneView({
          id: BoardLaneId.make("fallback:unmapped"),
          name: LaneName.make("Unmapped"),
          sources: [],
          origin: "fallback",
          items: [],
        }),
      ],
    });
    const mutation = labelMutationForBoardMove(board, target);
    assert.deepStrictEqual(mutation.add, [review]);
    assert.deepStrictEqual(mutation.remove, [ready]);
  });

  it.effect("keeps proposed label lanes read-only and preserves descriptive labels", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const documentation = GitHubLabelName.make("documentation");
      const labels = [bug, documentation, ready];
      const board = yield* projectBoard(managed, [...labels, review], [itemWithLabels(labels)], []);
      const target = board.lanes.find(({ name }) => name === reviewLane);
      assert(target !== undefined);
      assert(board.lanes.every((lane) => lane._tag === "ReadOnlyBoardLane"));
      assert.deepStrictEqual(board.lanes.flatMap(({ items }) => items)[0]?.labels, labels);
      assert.throws(() =>
        Schema.decodeUnknownSync(WritableBoardLaneView)({
          ...target,
          _tag: "WritableBoardLane",
          labels: [review],
        }),
      );
    }),
  );
});

describe("Task usage", () => {
  const ended = (startedAt: string, endedAt: string | null) => ({
    startedAt,
    endedAt,
    outcome: new SucceededAttemptView(),
  });
  const harnesses = { apiKeys: "pi", claudePlan: "claude", chatgptPlan: "codex" } as const;
  /** Returns one session of `attempt` using `tokens` from `pool`, priced at `usd` or unpriced. */
  const session = (
    attempt: string,
    pool: BillingPool,
    tokens: number,
    usd: number | null,
  ): SessionUsageView =>
    new SessionUsageView({
      attemptId: AttemptId.make(attempt),
      session: new ParentSession({
        id: AgentSessionId.make(`${attempt}-${pool}`),
        agent: AgentName.make("developer"),
        brain: new BrainSpec({
          harness: harnesses[pool],
          model: ModelId.make("model"),
          effort: "high",
        }),
      }),
      pool,
      tokens: TokenCount.make(tokens),
      cost:
        usd === null
          ? null
          : new UsageCostView({ usd: UsdAmount.make(usd), estimate: pool === "claudePlan" }),
    });
  /**
   * Returns a Run's usage as `RunUsageReader` reads it: a pool has no price while a session has
   * none.
   */
  const runUsage = (sessions: ReadonlyArray<SessionUsageView>) =>
    new RunUsageView({
      tokens: TokenCount.make(sessions.reduce((sum, { tokens }) => sum + tokens, 0)),
      pools: [...new Set(sessions.map(({ pool }) => pool))].map((pool) => {
        const members = sessions.filter((member) => member.pool === pool);
        const costs = members.flatMap(({ cost }) => (cost === null ? [] : [cost]));
        return new PoolUsageView({
          pool,
          tokens: TokenCount.make(members.reduce((sum, { tokens }) => sum + tokens, 0)),
          cost:
            pool === "chatgptPlan" || costs.length < members.length
              ? null
              : new UsageCostView({
                  usd: UsdAmount.make(costs.reduce((sum, { usd }) => sum + usd, 0)),
                  estimate: pool === "claudePlan",
                }),
        });
      }),
      sessions,
    });
  const pools = ({ pools: lines }: ReturnType<typeof taskUsage>) =>
    lines.map(
      ({ pool, tokens, cost, unpriced }): readonly [string, number, number | null, boolean] => [
        pool,
        tokens,
        cost?.usd ?? null,
        unpriced,
      ],
    );
  const priced = RunId.make("priced");
  const chatgpt = RunId.make("chatgpt");

  it("adds up a priced Run and a ChatGPT plan Run: time, tokens, pools, and the priced dollars", () => {
    const usage = taskUsage(
      [
        {
          id: priced,
          attempts: [
            ended("2026-10-20T10:00:00.000Z", "2026-10-20T10:40:00.000Z"),
            // Closed before end times were recorded, so it is not counted.
            ended("2026-10-20T11:00:00.000Z", null),
          ],
        },
        {
          id: chatgpt,
          attempts: [
            ended("2026-10-20T12:00:00.000Z", "2026-10-20T12:08:00.000Z"),
            { startedAt: "2026-10-20T12:10:00.000Z", endedAt: null, outcome: null },
          ],
        },
      ],
      new Map([
        [
          priced,
          runUsage([
            session("priced-1", "apiKeys", 1_500, 0.75),
            session("priced-1", "claudePlan", 20_000, 1.25),
          ]),
        ],
        [
          chatgpt,
          runUsage([
            session("chatgpt-1", "chatgptPlan", 800, null),
            session("chatgpt-2", "chatgptPlan", 5_000, null),
          ]),
        ],
      ]),
    );
    assert.strictEqual(usage.durationMillis, 48 * 60_000);
    assert.deepStrictEqual(usage.runningSince, ["2026-10-20T12:10:00.000Z"]);
    assert.strictEqual(usage.unmeasured, 1);
    assert.strictEqual(usage.tokens, 27_300);
    // The ChatGPT plan has no dollar rate, so its usage isn't counted as missing a price.
    assert.deepStrictEqual(pools(usage), [
      ["apiKeys", 1_500, 0.75, false],
      ["claudePlan", 20_000, 1.25, false],
      ["chatgptPlan", 5_800, null, false],
    ]);
    assert.deepStrictEqual({ ...usage.cost }, { usd: 2, estimate: true });
  });

  it("keeps the priced dollars when a Run at work has no price yet, and says the pool is unpriced", () => {
    const running = RunId.make("running");
    const finished = runUsage([
      session("priced-1", "apiKeys", 1_000, 0.5),
      session("priced-1", "claudePlan", 30_000, 2),
    ]);
    // The retry's Claude session has reported tokens but not its first result, so its Run's
    // Claude plan pool has no price, not even the ended Attempt's $0.75.
    const atWork = runUsage([
      session("running-1", "claudePlan", 10_000, 0.75),
      session("running-2", "claudePlan", 4_000, null),
    ]);
    const usage = taskUsage(
      [
        { id: priced, attempts: [] },
        { id: running, attempts: [] },
      ],
      new Map([
        [priced, finished],
        [running, atWork],
      ]),
    );
    assert.strictEqual(usage.tokens, 45_000);
    assert.deepStrictEqual(pools(usage), [
      ["apiKeys", 1_000, 0.5, false],
      ["claudePlan", 44_000, 2.75, true],
    ]);
    assert.deepStrictEqual({ ...usage.cost }, { usd: 3.25, estimate: true });
  });

  it("has no cost when no session in a pool with a dollar rate has a price", () => {
    const usage = taskUsage(
      [{ id: chatgpt, attempts: [] }],
      new Map([
        [
          chatgpt,
          runUsage([
            session("chatgpt-1", "apiKeys", 400, null),
            session("chatgpt-1", "chatgptPlan", 300, null),
          ]),
        ],
      ]),
    );
    assert.deepStrictEqual(pools(usage), [
      ["apiKeys", 400, null, true],
      ["chatgptPlan", 300, null, false],
    ]);
    assert.strictEqual(usage.cost, null);
  });
});
