import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { AgentName } from "@usine/core/agent";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
} from "@usine/engine/item-projection";
import { DateTime, Effect, Schema } from "effect";
import { projectBoard } from "../src/board/projection.ts";
import type { BoardView } from "../src/operator/board.ts";
import { RunView, type RunStateTag } from "../src/operator/run.ts";

const repository = RepositoryName.make("basaltbytes/usine");

// The dogfood instance's lanes, where every Loop removes its trigger label first (#467).
const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [
    {
      name: repository,
      lanes: [
        { name: "Ready", sources: [{ label: "ready-for-agent" }] },
        { name: "In progress", sources: [{ label: "agent-in-progress" }] },
        { name: "Review", sources: [{ label: "ready-for-review" }] },
        { name: "Findings", sources: [{ label: "agent-review-findings" }] },
        { name: "Passed", sources: [{ label: "review-passed" }] },
        { name: "Merge", sources: [{ label: "ready-to-merge" }] },
        { name: "Pull requests", sources: [{ state: "pr-open" }] },
        { name: "Done", sources: [{ state: "pr-merged" }, { state: "issue-closed" }] },
      ],
    },
  ],
});

const labelNodes = (labels: ReadonlyArray<string>) => ({
  totalCount: labels.length,
  nodes: labels.map((name) => ({ name })),
});

const itemKey = (number: number) => ItemKey.make(`github:${repository}:${number}`);

const issue = (number: number, labels: ReadonlyArray<string>) =>
  new ItemProjection({
    itemKey: itemKey(number),
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`issue-${number}:${labels.join(",")}`),
    payload: {
      number,
      title: `Issue ${number}`,
      body: "",
      url: `https://github.com/${repository}/issues/${number}`,
      state: "OPEN",
      stateReason: null,
      createdAt: "2026-10-21T10:00:00Z",
      updatedAt: "2026-10-21T17:00:00Z",
      closedAt: null,
      author: { login: "PhilDL" },
      issueType: null,
      milestone: null,
      labels: labelNodes(labels),
      assignees: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
    },
  });

const pullRequest = (number: number, labels: ReadonlyArray<string>, merged = false) =>
  new ItemProjection({
    itemKey: itemKey(number),
    repository,
    source: ItemProjectionSource.make("pr"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`pr-${number}:${labels.join(",")}:${merged}`),
    payload: {
      number,
      title: `Pull request ${number}`,
      body: "",
      url: `https://github.com/${repository}/pull/${number}`,
      state: merged ? "MERGED" : "OPEN",
      isDraft: false,
      merged,
      createdAt: "2026-10-21T10:00:00Z",
      updatedAt: "2026-10-21T17:00:00Z",
      mergedAt: merged ? "2026-10-21T17:30:00Z" : null,
      author: { login: "usine-bot" },
      baseRefName: "main",
      headRefName: `fix/${number}`,
      headRefOid: "81c048b",
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      reviewDecision: null,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: null,
      labels: labelNodes(labels),
      reviewRequests: { totalCount: 0, nodes: [] },
      reviews: { totalCount: 0, nodes: [] },
      reviewThreads: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closingIssuesReferences: { totalCount: 0, nodes: [] },
    },
  });

const isOpen = (state: RunStateTag) =>
  state === "Pending" || state === "Waiting" || state === "Queued" || state === "Running";

const run = (item: ItemProjection, loop: string, state: RunStateTag) =>
  new RunView({
    agentBrain: new BrainSpec({
      harness: "codex",
      model: ModelId.make("test-model"),
      effort: "high",
    }),
    id: RunId.make(`${loop}-${item.number}`),
    itemKey: item.itemKey,
    loop: LoopName.make(loop),
    repository,
    agent: AgentName.make("developer"),
    state,
    loopPaused: false,
    openedAt: "2026-10-21T17:55:00.000Z",
    closedAt: isOpen(state) ? null : "2026-10-21T18:10:00.000Z",
    task: `Work on #${item.number}.`,
    attempts: [],
    approval: null,
    runAgain: null,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: state === "Waiting",
    canRetry: state === "Failed",
    canResolveFailure: state === "Failed",
    canCancel: isOpen(state),
    canRunAgain: state === "Succeeded" || state === "Canceled",
  });

/** Returns the Event that `opened` was opened for, with `payload` as the Item its trigger saw. */
const eventOf = (opened: RunView, payload: Schema.JsonObject) =>
  [
    opened.id,
    new Event({
      id: EventId.make(`event-${opened.id}`),
      dedupKey: DedupKey.make(`event-${opened.id}`),
      payload,
      receivedAt: DateTime.makeUnsafe("2026-10-21T17:54:00Z"),
    }),
  ] as const;

/** Returns the Event that `opened` was opened for, when `item` had `labels`. */
const triggeredWith = (opened: RunView, item: ItemProjection, labels: ReadonlyArray<string>) =>
  eventOf(opened, { ...item.payload, labels: labelNodes(labels) });

const project = (
  items: ReadonlyArray<ItemProjection>,
  runs: ReadonlyArray<RunView>,
  events: ReadonlyArray<ReturnType<typeof eventOf>> = [],
) =>
  Effect.gen(function* () {
    const managed = config.repos[0];
    assert(managed !== undefined);
    return yield* projectBoard(managed, [], items, runs, [], new Map(), new Map(), new Map(events));
  });

/** Returns each lane's name and the numbers of its cards. */
const lanes = (board: BoardView) =>
  Object.fromEntries(
    board.lanes.map(
      ({ name, items }) => [name, items.map(({ number }): number => number)] as const,
    ),
  );

describe("The lane of a running Task", () => {
  it.effect("is the lane its Item's labels match, after the Agent swapped its trigger label", () =>
    Effect.gen(function* () {
      // start-dev swapped ready-for-agent for agent-in-progress; review-pr set its finding label.
      const develop = issue(470, ["agent-in-progress", "bug"]);
      const review = pullRequest(474, ["agent-review-findings"]);
      const runs = [
        run(develop, "start-dev", "Running"),
        run(review, "review-pr", "Running"),
      ] as const;
      const board = yield* project([develop, review], runs, [
        triggeredWith(runs[0], develop, ["ready-for-agent", "bug"]),
        triggeredWith(runs[1], review, ["ready-for-review"]),
      ]);
      assert.deepStrictEqual(lanes(board), {
        Ready: [],
        "In progress": [470],
        Review: [],
        Findings: [474],
        Passed: [],
        Merge: [],
        "Pull requests": [],
        Done: [],
        Unmapped: [],
      });
      assert.deepStrictEqual(
        board.lanes.flatMap(({ items }) => items.map(({ run }): string | undefined => run?.loop)),
        ["start-dev", "review-pr"],
      );
    }),
  );

  it.effect(
    "is the lane its Run's trigger label routed to, after the Agent removed that label",
    () =>
      Effect.gen(function* () {
        // The PR Loops removed their trigger labels and set no other lane label.
        const review = pullRequest(466, []);
        const findings = pullRequest(472, ["bug"]);
        const finish = pullRequest(468, []);
        const runs = [
          run(review, "review-pr", "Running"),
          run(findings, "act-on-findings", "Running"),
          run(finish, "finish-pr", "Running"),
        ] as const;
        const board = yield* project([review, findings, finish, pullRequest(319, [])], runs, [
          triggeredWith(runs[0], review, ["ready-for-review"]),
          triggeredWith(runs[1], findings, ["agent-review-findings", "bug"]),
          triggeredWith(runs[2], finish, ["review-passed"]),
        ]);
        assert.deepStrictEqual(lanes(board), {
          Ready: [],
          "In progress": [],
          Review: [466],
          Findings: [472],
          Passed: [468],
          Merge: [],
          // A pull request with no Run is placed by its state, as before.
          "Pull requests": [319],
          Done: [],
          Unmapped: [],
        });
        // Each card includes the Run that sets its lane, so its Run line shows which Loop runs.
        assert.deepStrictEqual(
          board.lanes.flatMap(({ items }) =>
            items.map(({ number, run }): readonly [number, string | undefined] => [
              number,
              run?.loop,
            ]),
          ),
          [
            [466, "review-pr"],
            [472, "act-on-findings"],
            [468, "finish-pr"],
            [319, undefined],
          ],
        );
        // The card still shows the labels its Item has now.
        assert.deepStrictEqual<ReadonlyArray<string> | undefined>(
          board.lanes.find(({ name }) => name === "Findings")?.items[0]?.labels,
          ["bug"],
        );
      }),
  );

  it.effect("follows the label the Loop set next once its Run ends", () =>
    Effect.gen(function* () {
      const reviewed = pullRequest(466, ["agent-review-findings"]);
      const ended = run(reviewed, "review-pr", "Succeeded");
      const board = yield* project(
        [reviewed],
        [ended],
        [triggeredWith(ended, reviewed, ["ready-for-review"])],
      );
      assert.deepStrictEqual(lanes(board).Findings, [466]);
      assert.deepStrictEqual(lanes(board).Review, []);
    }),
  );

  it.effect("is its Item's lane while its Run has not started", () =>
    Effect.gen(function* () {
      // The operator moved the card while its Run queued; the next poll revokes that Run.
      const moved = pullRequest(466, ["ready-to-merge"]);
      const queued = run(moved, "review-pr", "Queued");
      const board = yield* project(
        [moved],
        [queued],
        [triggeredWith(queued, moved, ["ready-for-review"])],
      );
      assert.deepStrictEqual(lanes(board).Merge, [466]);
      assert.deepStrictEqual(lanes(board).Review, []);
    }),
  );

  it.effect(
    "is its Item's lane once the Item is merged, without its Run's Event, or when that Event names no lane label",
    () =>
      Effect.gen(function* () {
        const merged = pullRequest(466, [], true);
        const unread = pullRequest(468, []);
        const unlabeled = pullRequest(469, []);
        const rebased = pullRequest(471, ["dependencies"]);
        const runs = [
          run(merged, "review-pr", "Running"),
          run(unread, "finish-pr", "Running"),
          run(unlabeled, "review-pr", "Running"),
          run(rebased, "rebase-pr", "Running"),
        ] as const;
        const board = yield* project([merged, unread, unlabeled, rebased], runs, [
          triggeredWith(runs[0], merged, ["ready-for-review"]),
          // An Event whose payload has no labels is logged and doesn't set its card's lane.
          eventOf(runs[2], { number: 469 }),
          triggeredWith(runs[3], rebased, ["dependencies"]),
        ]);
        assert.deepStrictEqual(lanes(board)["Pull requests"], [471, 469, 468]);
        assert.deepStrictEqual(lanes(board).Done, [466]);
        assert.deepStrictEqual(board.failures, []);
      }),
  );
});
