import { assert, describe, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/config/label";
import { LabelLaneSource, LaneName } from "@usine/config/board";
import { UsineConfig } from "@usine/config/factory";
import { AgentName } from "@usine/core/agent";
import { ItemKey, ItemNumber as CoreItemNumber, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
} from "@usine/engine/item-projection";
import { Effect, Schema } from "effect";
import { labelMutationForBoardMove, projectBoard } from "../src/board/projection.ts";
import {
  BoardTaskView,
  BoardItemLink,
  BoardLaneId,
  BoardView,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
} from "../src/operator/board.ts";
import { RunView } from "../src/operator/run.ts";

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
    task: "Build the Board.",
    attempts: [],
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: state === "Waiting",
    canRetry: state === "Failed",
    canResolveFailure: state === "Failed",
    canCancel: state === "Waiting" || state === "Running",
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

  it.effect("leaves a closed issue unmapped instead of placing it by a leftover label", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository, lanes: [{ name: "Ready", sources: [{ label: ready }] }] }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const board = yield* projectBoard(managed, [], [closedItem], []);
      assert.deepStrictEqual(board.lanes[0]?.items, []);
      const unmapped = board.lanes.find(({ origin }) => origin === "fallback");
      assert.strictEqual(unmapped?.items[0]?.itemKey, itemKey);
      assert.strictEqual(unmapped?.items[0]?.state, "issue-closed");
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
        const board = yield* projectBoard(
          managed,
          [],
          [itemWithLabels([]), pr],
          [reviewRun, development],
          [itemKey],
        );
        const card = board.lanes[0]?.items[0];
        assert(card !== undefined);
        assert.strictEqual(card.title, "Board lanes");
        assert.strictEqual(card.itemKey, pr.itemKey);
        assert.deepStrictEqual(
          card.items.map(({ number }) => number),
          [33, 98],
        );
        assert.deepStrictEqual(
          card.runs.map(({ id }) => id),
          [development.id, reviewRun.id],
        );
        assert.strictEqual(card.needsYou, true);
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
        }),
      ],
      labels: [bug],
      runs: [],
      run: null,
      needsYou: false,
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
