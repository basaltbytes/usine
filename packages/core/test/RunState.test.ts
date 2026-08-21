import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { EventId } from "../src/Event.ts";
import * as RunState from "../src/RunState.ts";

describe("run state machine (ADR 0002)", () => {
  it("a gated run reaches running only through waiting", () => {
    const waiting = RunState.awaitApproval(new RunState.Pending());
    expect(waiting._tag).toBe("Waiting");
    expect(RunState.start(waiting)._tag).toBe("Running");
  });

  it("an ungated run starts straight from pending", () => {
    expect(RunState.start(new RunState.Pending())._tag).toBe("Running");
  });

  it("a finished attempt closes the run as succeeded or failed", () => {
    const running = new RunState.Running();
    expect(RunState.succeed(running)._tag).toBe("Succeeded");
    expect(RunState.fail(running)._tag).toBe("Failed");
  });

  it("operator retry reopens a failed run for attempt N+1", () => {
    const failed = RunState.fail(new RunState.Running());
    expect(RunState.retry(failed)._tag).toBe("Running");
  });

  it("operator cancel reaches every open state and records the operator as reason", () => {
    const open: ReadonlyArray<RunState.Open> = [
      new RunState.Pending(),
      new RunState.Waiting(),
      new RunState.Running(),
    ];
    for (const state of open) {
      const canceled = RunState.cancel(state);
      expect(canceled._tag).toBe("Canceled");
      expect(canceled.reason._tag).toBe("OperatorCanceled");
    }
  });

  it("supersede records which Event took the run's place", () => {
    const by = EventId.make("evt-2");
    const canceled = RunState.supersede(new RunState.Pending(), by);
    expect(canceled.reason._tag).toBe("Superseded");
    expect(canceled.reason._tag === "Superseded" && canceled.reason.by).toBe(by);
  });

  it("revoke records its own reason, distinct from operator cancel and supersede", () => {
    const canceled = RunState.revoke(new RunState.Waiting());
    expect(canceled.reason._tag).toBe("Revoked");
  });

  it("only pending, waiting and running are open", () => {
    expect(RunState.isOpen(new RunState.Pending())).toBe(true);
    expect(RunState.isOpen(new RunState.Waiting())).toBe(true);
    expect(RunState.isOpen(new RunState.Running())).toBe(true);
    expect(RunState.isOpen(new RunState.Succeeded())).toBe(false);
    expect(RunState.isOpen(new RunState.Failed())).toBe(false);
    expect(RunState.isOpen(RunState.cancel(new RunState.Pending()))).toBe(false);
  });

  // The transitions are typestate: illegality is a compile error, enforced by
  // the `check` script (tsc over this file). If a signature ever widens so one
  // of these calls compiles, its @ts-expect-error turns into an "unused
  // directive" error and CI fails. The calls are pure, so running them is
  // harmless.
  it("illegal transitions do not compile", () => {
    const pending = new RunState.Pending();
    const waiting = new RunState.Waiting();
    const running = new RunState.Running();
    const succeeded = new RunState.Succeeded();
    const failed = new RunState.Failed();
    const canceled = RunState.cancel(pending);

    // Only a running attempt can finish.
    // @ts-expect-error a pending run has no attempt to succeed
    RunState.succeed(pending);
    // @ts-expect-error a waiting run has no attempt to fail
    RunState.fail(waiting);

    // Closed runs never move again — except failed → running via retry.
    // @ts-expect-error a succeeded run cannot be retried
    RunState.retry(succeeded);
    // @ts-expect-error a canceled run cannot be retried
    RunState.retry(canceled);
    // @ts-expect-error only a failed run can be retried
    RunState.retry(running);
    // @ts-expect-error a succeeded run cannot be canceled
    RunState.cancel(succeeded);
    // @ts-expect-error a failed run cannot be canceled — retry it or leave it closed
    RunState.cancel(failed);
    // @ts-expect-error a closed run cannot start again
    RunState.start(canceled);

    // A started attempt always finishes (ADR 0007): supersede and revoke stop
    // at pending | waiting.
    // @ts-expect-error a running attempt cannot be superseded
    RunState.supersede(running, EventId.make("evt-3"));
    // @ts-expect-error a running attempt cannot be revoked
    RunState.revoke(running);
    // @ts-expect-error a closed run cannot be superseded
    RunState.supersede(succeeded, EventId.make("evt-4"));

    // The approval gate is entered exactly once, from pending.
    // @ts-expect-error only a pending run can be parked on the approval gate
    RunState.awaitApproval(running);
  });

  it("a stored state row parses back into the same state", () => {
    const canceled = RunState.supersede(new RunState.Waiting(), EventId.make("evt-9"));
    const encoded = Schema.encodeSync(RunState.RunState)(canceled);
    const decoded = Schema.decodeUnknownSync(RunState.RunState)(encoded);
    expect(decoded).toEqual(canceled);
  });

  it("a state row with an unknown tag is rejected", () => {
    expect(() => Schema.decodeUnknownSync(RunState.RunState)({ _tag: "Paused" })).toThrow();
  });
});
