import { Source } from "@usine/expression/expression-engine";
import { makeExpressionEngine } from "@usine/expression/marcbachmann-cel";
import { assert, describe, it } from "@effect/vitest";
import { LabelLaneSource, Lane, LaneName, StateLaneSource } from "@usine/config/board";
import { GitHubLabelName } from "@usine/config/label";
import { LoopFile, PriorityValue, evaluateLoopPriority } from "@usine/config/loop";
import { WorkerName } from "@usine/core/worker";
import { Array as EffectArray, Effect, Option, Schema } from "effect";
import {
  aheadCount,
  type LeaseCandidate,
  leaseOrder,
  passedCount,
  type PipelinePosition,
  pipelinePosition,
} from "../src/lease-order.ts";

const labelLane = (name: string, ...labels: ReadonlyArray<string>) =>
  new Lane({
    name: LaneName.make(name),
    sources: labels.map((label) => new LabelLaneSource({ label: GitHubLabelName.make(label) })),
  });

const lanes = [
  labelLane("Ready", "ready-for-agent"),
  labelLane("In progress", "agent-in-progress"),
  labelLane("Review", "ready-for-review"),
  new Lane({
    name: LaneName.make("Pull requests"),
    sources: [new StateLaneSource({ state: "pr-open" })],
  }),
  labelLane("Merge", "ready-to-merge"),
];

const noPriority = PriorityValue.make(0);

describe("Pipeline position", () => {
  it("is the first lane, in lanes order, with a label of the Item, ignoring case", () => {
    assert.deepStrictEqual(pipelinePosition(noPriority, lanes, ["Ready-For-Review"]), {
      priority: noPriority,
      lane: Option.some({ name: LaneName.make("Review"), number: 3 }),
    });
    assert.deepStrictEqual(
      pipelinePosition(noPriority, lanes, ["ready-to-merge", "agent-in-progress"]),
      {
        priority: noPriority,
        lane: Option.some({ name: LaneName.make("In progress"), number: 2 }),
      },
    );
  });

  it("retains the lane when a priority is set", () => {
    assert.deepStrictEqual(pipelinePosition(PriorityValue.make(1), lanes, ["ready-to-merge"]), {
      priority: PriorityValue.make(1),
      lane: Option.some({ name: LaneName.make("Merge"), number: 5 }),
    });
  });

  it("is unset without a priority or a label that a lane has", () => {
    assert.deepStrictEqual(pipelinePosition(noPriority, lanes, ["bug"]), {
      priority: noPriority,
      lane: Option.none(),
    });
    assert.deepStrictEqual(pipelinePosition(noPriority, [], ["ready-for-agent"]), {
      priority: noPriority,
      lane: Option.none(),
    });
  });
});

const lane = (number: number): PipelinePosition => ({
  priority: noPriority,
  lane: Option.some({ name: LaneName.make(`lane-${number}`), number }),
});
const priority = (value: number): PipelinePosition => ({
  lane: Option.none(),
  priority: PriorityValue.make(value),
});
const unpositioned: PipelinePosition = { priority: noPriority, lane: Option.none() };

const candidate = (
  order: number,
  position: PipelinePosition,
  worker: Option.Option<WorkerName> = Option.none(),
): LeaseCandidate => ({ worker, position, eventTime: 1_000 + order, order });

const leased = (candidates: ReadonlyArray<LeaseCandidate>) =>
  EffectArray.sort(candidates, leaseOrder).map(({ order }) => order);

describe("Lease order", () => {
  it("leases to a Run in a later lane before Runs in an earlier lane whose Events arrived first", () => {
    const startDev = [1, 2, 3, 4].map((order) => candidate(order, lane(1)));
    const reviewPr = candidate(5, lane(3));
    assert.deepStrictEqual(leased([...startDev, reviewPr]), [5, 1, 2, 3, 4]);
    assert.strictEqual(passedCount([...startDev, reviewPr], reviewPr), 4);
  });

  it("keeps Event order among Runs at the same position", () => {
    assert.deepStrictEqual(
      leased([candidate(3, lane(2)), candidate(1, lane(2)), candidate(2, lane(2))]),
      [1, 2, 3],
    );
    assert.strictEqual(passedCount([candidate(2, lane(2))], candidate(1, lane(2))), 0);
  });

  it("puts Runs without a position after positioned Runs, in Event order", () => {
    assert.deepStrictEqual(
      leased([candidate(1, unpositioned), candidate(2, lane(1)), candidate(3, unpositioned)]),
      [2, 1, 3],
    );
  });

  it("puts Runs of Loops with a priority before lane order, higher priority first", () => {
    assert.deepStrictEqual(
      leased([candidate(1, lane(5)), candidate(2, priority(1)), candidate(3, priority(2))]),
      [3, 2, 1],
    );
  });

  it("puts a reservation that names a Worker before every position", () => {
    assert.deepStrictEqual(
      leased([
        candidate(1, priority(9)),
        candidate(2, unpositioned, Option.some(WorkerName.make("local"))),
      ]),
      [2, 1],
    );
  });
});

describe("Runs ahead", () => {
  const local = WorkerName.make("local");
  const spare = WorkerName.make("spare");
  const reattaching = candidate(1, unpositioned, Option.some(local));
  const earlier = candidate(2, lane(1));
  const waiting = candidate(3, lane(1));

  it("leaves out a reservation that names a Worker while another Worker that takes Attempts has none", () => {
    assert.strictEqual(aheadCount([reattaching, earlier], waiting, [local, spare]), 1);
  });

  it("counts a reservation that names the only Worker that takes Attempts", () => {
    assert.strictEqual(aheadCount([reattaching, earlier], waiting, [local]), 2);
  });

  it("counts, while each Worker that takes Attempts has reservations that name it, those of the Worker with the fewest", () => {
    const onSpare = candidate(4, unpositioned, Option.some(spare));
    assert.strictEqual(aheadCount([reattaching, onSpare], waiting, [local, spare]), 1);
    const alsoLocal = candidate(5, unpositioned, Option.some(local));
    assert.strictEqual(
      aheadCount([reattaching, alsoLocal, onSpare, earlier], waiting, [local, spare]),
      2,
    );
  });

  it("counts, for a reservation that names a Worker, only the earlier ones that name it too", () => {
    const onSpare = candidate(4, unpositioned, Option.some(spare));
    const alsoLocal = candidate(5, unpositioned, Option.some(local));
    assert.strictEqual(aheadCount([reattaching, onSpare], alsoLocal, [local, spare]), 1);
  });
});

it.effect("orders label-driven priorities before event time and rejects unsafe integers", () =>
  Effect.gen(function* () {
    const loop = Schema.decodeUnknownSync(LoopFile)({
      name: "start-dev",
      trigger: { on: "issue", if: "true" },
      selector: Option.none(),
      approval: "none",
      step: "run",
      agent: "developer",
      body: "Implement.",
      priority: Option.some('item.labels.nodes.exists(l, l.name == "low-priority") ? -1 : 0'),
    });
    const engine = makeExpressionEngine();
    const outOfRange = new LoopFile({
      ...loop,
      priority: Option.some(Source.make("9007199254740992")),
    });
    const failure = yield* evaluateLoopPriority(engine, outOfRange, {}).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "ExpressionEvaluationError");
    assert.include(failure.message, "safe integer");
    const candidates = yield* Effect.forEach(
      [["ready-for-agent", "low-priority"], ["ready-for-agent"], ["ready-for-agent"]],
      (labels, index) =>
        Effect.gen(function* () {
          const priority = yield* evaluateLoopPriority(engine, loop, {
            item: { labels: { nodes: labels.map((name) => ({ name })) } },
          });
          return candidate(index + 1, pipelinePosition(priority, lanes, labels));
        }),
    );
    assert.deepStrictEqual(leased(candidates), [2, 3, 1]);
    const equalPriority = PriorityValue.make(-1);
    assert.deepStrictEqual(
      leased([
        candidate(1, pipelinePosition(equalPriority, lanes, ["ready-for-agent"])),
        candidate(2, pipelinePosition(equalPriority, lanes, ["ready-to-merge"])),
        candidate(3, pipelinePosition(PriorityValue.make(0), [], [])),
      ]),
      [3, 2, 1],
    );
  }),
);
