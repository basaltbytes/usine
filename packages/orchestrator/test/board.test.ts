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
  BoardItemView,
  BoardLaneId,
  BoardView,
  ReadOnlyBoardLaneView,
  RunView,
  WritableBoardLaneView,
} from "../src/operator/model.ts";

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
        [running.id, waiting.id, failed.id],
      );
    }),
  );

  it("derives an authored lane mutation without trusting truncated card labels", () => {
    const card = new BoardItemView({
      itemKey,
      kind: "issue",
      number: CoreItemNumber.make(33),
      title: "Board lanes",
      url: "https://github.com/basaltbytes/usine/issues/33",
      state: "issue-open",
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

  it.effect("moves a proposed card to the selected Lane after re-projection", () =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository }],
      });
      const managed = config.repos[0];
      assert(managed !== undefined);
      const board = yield* projectBoard(managed, [bug, ready, review], [item], []);
      const target = board.lanes.find(({ name }) => name === reviewLane);
      assert(target !== undefined && target._tag === "WritableBoardLane");

      const mutation = labelMutationForBoardMove(board, target);
      assert.deepStrictEqual(mutation.add, [review]);
      assert.deepStrictEqual(mutation.remove, [bug, ready]);

      const moved = yield* projectBoard(
        managed,
        [bug, ready, review],
        [itemWithLabels([review])],
        [],
      );
      const targetAfterMove = moved.lanes.find(({ name }) => name === reviewLane);
      assert(targetAfterMove !== undefined);
      assert.strictEqual(targetAfterMove.items[0]?.itemKey, itemKey);
    }),
  );
});
