import { assert, describe, it } from "@effect/vitest";
import { GitHubLabelName, LabelLaneSource, LaneName, UsineConfig } from "@usine/config";
import { Item, Repository } from "@usine/core";
import { ItemContentHash, ItemNumber, ItemProjection, ItemProjectionSource } from "@usine/engine";
import { Effect, Schema } from "effect";
import { labelMutationForBoardMove, projectBoard } from "../src/board/projection.ts";
import {
  BoardItemView,
  BoardLaneId,
  BoardView,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
} from "../src/operator/model.ts";

const repository = Repository.Name.make("basaltbytes/usine");
const itemKey = Item.ItemKey.make("github:basaltbytes/usine:33");
const ready = GitHubLabelName.make("ready-for-agent");
const review = GitHubLabelName.make("ready-for-review");
const bug = GitHubLabelName.make("bug");
const item = new ItemProjection({
  itemKey,
  repository,
  source: ItemProjectionSource.make("issue"),
  number: ItemNumber.make(33),
  contentHash: ItemContentHash.make("issue-33"),
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
      totalCount: 2,
      nodes: [{ name: ready }, { name: bug }],
    },
    assignees: { totalCount: 0, nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
  },
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

  it("derives an authored lane mutation without trusting truncated card labels", () => {
    const card = new BoardItemView({
      itemKey,
      kind: "issue",
      number: Item.Number.make(33),
      title: "Board lanes",
      url: "https://github.com/basaltbytes/usine/issues/33",
      state: "issue-open",
      labels: [bug],
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
    const mutation = labelMutationForBoardMove(board, card, target);
    assert.deepStrictEqual(mutation.add, [review]);
    assert.deepStrictEqual(mutation.remove, [ready]);
  });

  it("removes only the current proposed lane label", () => {
    const card = new BoardItemView({
      itemKey,
      kind: "issue",
      number: Item.Number.make(33),
      title: "Board lanes",
      url: "https://github.com/basaltbytes/usine/issues/33",
      state: "issue-open",
      labels: [ready, bug],
      run: null,
      needsYou: false,
    });
    const source = new WritableBoardLaneView({
      id: BoardLaneId.make("proposed:Ready"),
      name: LaneName.make("Ready"),
      sources: [new LabelLaneSource({ label: ready })],
      labels: [ready],
      origin: "proposed",
      items: [card],
    });
    const target = new WritableBoardLaneView({
      id: BoardLaneId.make("proposed:Review"),
      name: LaneName.make("Review"),
      sources: [new LabelLaneSource({ label: review })],
      labels: [review],
      origin: "proposed",
      items: [],
    });
    const board = new BoardView({ failures: [], lanes: [source, target] });
    const mutation = labelMutationForBoardMove(board, card, target);
    assert.deepStrictEqual(mutation.add, [review]);
    assert.deepStrictEqual(mutation.remove, [ready]);
  });
});
