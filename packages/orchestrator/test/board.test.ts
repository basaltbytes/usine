import { assert, describe, it } from "@effect/vitest";
import { GitHubLabelName, LabelLaneSource, LaneName, UsineConfig } from "@usine/config";
import { Agent, Item, Loop, Repository, Run } from "@usine/core";
import { ItemContentHash, ItemNumber, ItemProjection, ItemProjectionSource } from "@usine/engine";
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

const repository = Repository.Name.make("basaltbytes/usine");
const itemKey = Item.ItemKey.make("github:basaltbytes/usine:33");
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

const runForBoard = (id: string, state: "Waiting" | "Running" | "Failed" | "Succeeded") =>
  new RunView({
    id: Run.RunId.make(id),
    itemKey,
    loop: Loop.LoopName.make(`loop-${id}`),
    repository,
    agent: Agent.Name.make("developer"),
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
        itemKey: Item.ItemKey.make("github:basaltbytes/usine:34"),
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
      number: Item.Number.make(33),
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
