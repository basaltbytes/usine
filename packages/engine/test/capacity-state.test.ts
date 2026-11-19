import { assert, describe, it } from "@effect/vitest";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { AttemptId } from "@usine/core/attempt";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Duration, Option } from "effect";
import {
  answered,
  type CapacityRefusal,
  type CapacityState,
  CapacityGroup,
  claim,
  emptyCapacity,
  force,
  refused,
  settled,
  turn,
  waitsOf,
} from "../src/engine/capacity/state.ts";

const loop = LoopName.make("review");
const claude = CapacityGroup.make({
  harness: Harness.make("claude"),
  model: ModelId.make("opus"),
  worker: WorkerName.make("local"),
});
const elsewhere = CapacityGroup.make({ ...claude, worker: WorkerName.make("remote") });
const sonnet = CapacityGroup.make({ ...claude, model: ModelId.make("sonnet") });
const at = (minutes: number) => DateTime.makeUnsafe(Duration.toMillis(Duration.minutes(minutes)));
const run = (name: string) => RunId.make(name);

/** A refusal of an Attempt of `runId` in `group` that ran from `startedAt` to `endedAt`. */
const refusal = (
  runId: RunId,
  startedAt: number,
  endedAt: number,
  group: CapacityGroup = claude,
): CapacityRefusal => ({
  runId,
  loop,
  group,
  attemptId: AttemptId.make(`${runId}/${endedAt}`),
  startedAt: at(startedAt),
  endedAt: at(endedAt),
  message: "You've hit your limit",
  resetsAt: Option.none(),
});

/** Applies `refusals` in order to an empty state. */
const refusedAll = (...refusals: ReadonlyArray<CapacityRefusal>): CapacityState =>
  refusals.reduce((state, next) => refused(state, next)[1], emptyCapacity);

const claimAt = (
  state: CapacityState,
  runId: RunId,
  now: number,
  group: CapacityGroup = claude,
  capacityTurn: "Due" | "Forced" = "Due",
) => claim(state, { runId, loop, group, turn: capacityTurn, now: at(now) });

describe("capacity state", () => {
  it("ignores a refusal that ended before the provider last answered in its group", () => {
    const marked = refusedAll(refusal(run("a"), 0, 1));
    const [, released] = answered(marked, {
      runId: run("b"),
      group: claude,
      startedAt: at(2),
      now: at(3),
    });
    // An Attempt that was already running when the provider recovered reports its refusal late.
    const [outcome, after] = refused(released, refusal(run("c"), 0, 2));
    assert.strictEqual(outcome, "Stale");
    assert.deepStrictEqual(waitsOf(after), []);
  });

  it("keeps the group at capacity when an Attempt that started before its latest refusal answers", () => {
    const marked = refusedAll(refusal(run("a"), 0, 5));
    const [outcome, after] = answered(marked, {
      runId: run("b"),
      group: claude,
      startedAt: at(1),
      now: at(6),
    });
    assert.strictEqual(outcome._tag, "Earlier");
    assert.deepStrictEqual(
      waitsOf(after).map(({ runIds }) => runIds),
      [[run("a")]],
    );
  });

  it("makes a new Run wait while another Attempt tests the group, even after its next try", () => {
    const marked = refusedAll(refusal(run("a"), 0, 0));
    const [probing] = turn(marked, run("a"), at(5));
    assert.strictEqual(probing._tag, "Due");
    const [, elected] = turn(marked, run("a"), at(5));
    const [tested] = claimAt(elected, run("a"), 5);
    assert.strictEqual(tested.claim, "Probe");
    const [late, after] = claimAt(claimAt(elected, run("a"), 5)[1], run("b"), 6);
    assert.strictEqual(late.claim, "Wait");
    assert.deepStrictEqual(waitsOf(after)[0]?.runIds, [run("b")]);
  });

  it("lets Runs on another model or Worker start while a group is at capacity", () => {
    const marked = refusedAll(refusal(run("a"), 0, 0));
    const claims = [sonnet, elsewhere, claude].map(
      (group, index) => claimAt(marked, run(`new-${index}`), 1, group)[0].claim,
    );
    assert.deepStrictEqual(claims, ["Free", "Free", "Wait"]);
  });

  it("elects one waiting Run to test the group at its next try", () => {
    const marked = refusedAll(refusal(run("a"), 0, 0), refusal(run("b"), 0, 0));
    const [first, elected] = turn(marked, run("a"), at(5));
    const [second] = turn(elected, run("b"), at(5));
    assert.deepStrictEqual([first._tag, second._tag], ["Due", "AwaitProbe"]);
  });

  it("lets an operator retry that arrived before the claim test the group before its next try", () => {
    const marked = refusedAll(refusal(run("a"), 0, 0));
    // The retry arrived after the Run's wait ended and before it claimed the group.
    const [claimed, after] = claimAt(force(marked, run("a")), run("a"), 1);
    assert.deepStrictEqual([claimed.claim, claimed.forced], ["Probe", true]);
    assert.isFalse(after.forced.has(run("a")));
  });

  it("drops the group that a Run stops waiting for when it waits for another group", () => {
    const marked = refusedAll(refusal(run("a"), 0, 0), refusal(run("b"), 0, 0, elsewhere));
    const [claimed, after] = claimAt(marked, run("a"), 1, elsewhere);
    assert.strictEqual(claimed.claim, "Wait");
    const [wait, ...others] = waitsOf(after);
    assert.deepStrictEqual(others, []);
    assert.strictEqual(wait?.group.worker, elsewhere.worker);
    assert.deepStrictEqual(wait?.runIds, [run("a"), run("b")]);
  });

  // A failure of the agent's work comes after the provider answered its requests.
  it.each(["Succeeded", "AgentFailure"] as const)(
    "releases the waiting Runs when the Attempt that tests the group ends with %s",
    (end) => {
      const marked = refusedAll(refusal(run("a"), 0, 0), refusal(run("b"), 0, 0));
      const [, elected] = turn(marked, run("a"), at(5));
      const [, probing] = claimAt(elected, run("a"), 5);
      const [outcome, after] = settled(probing, {
        runId: run("a"),
        group: claude,
        startedAt: at(5),
        end,
        now: at(6),
      });
      assert.deepStrictEqual(outcome, { _tag: "Released", runs: [[run("b"), loop]] });
      assert.deepStrictEqual(waitsOf(after), []);
    },
  );

  it("lets another waiting Run test the group after the testing Attempt fails on infrastructure", () => {
    const marked = refusedAll(refusal(run("a"), 0, 0), refusal(run("b"), 0, 0));
    const [, elected] = turn(marked, run("a"), at(5));
    const [, probing] = claimAt(elected, run("a"), 5);
    const [outcome, after] = settled(probing, {
      runId: run("a"),
      group: claude,
      startedAt: at(5),
      end: "InfraFailure",
      now: at(6),
    });
    assert.strictEqual(outcome._tag, "Left");
    const [next] = turn(after, run("b"), at(6));
    assert.deepStrictEqual(next, { _tag: "Due", elected: true, group: claude });
  });

  it("keeps the group at capacity when the testing Attempt is refused", () => {
    const marked = refusedAll(refusal(run("a"), 0, 0), refusal(run("b"), 0, 0));
    const [, elected] = turn(marked, run("a"), at(5));
    const [, probing] = claimAt(elected, run("a"), 5);
    const [outcome, after] = settled(probing, {
      runId: run("a"),
      group: claude,
      startedAt: at(5),
      end: "ProviderCapacityFailure",
      now: at(5),
    });
    assert.strictEqual(outcome._tag, "Refused");
    const [, waiting] = refused(after, refusal(run("a"), 5, 5));
    assert.deepStrictEqual(
      waitsOf(waiting).map(({ refusals, nextTryAt }) => [refusals, nextTryAt]),
      [[2, at(20)]],
    );
  });
});
