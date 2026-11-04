import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { EventId } from "../src/event.ts";
import * as RunState from "../src/run/state.ts";

const decodeRunState = Schema.decodeUnknownEffect(RunState.RunState);

describe("run state machine (ADR 0002)", () => {
  it("a gated run reaches running only through waiting and queued", () => {
    const waiting = RunState.awaitApproval(RunState.Pending.make());
    expect(waiting._tag).toBe("Waiting");
    expect(RunState.operatorActions(waiting).canApprove).toBe(true);
    const queued = RunState.approve(waiting);
    expect(queued._tag).toBe("Queued");
    expect(RunState.operatorActions(queued).canApprove).toBe(false);
    expect(RunState.start(queued)._tag).toBe("Running");
  });

  it("an ungated run starts straight from pending", () => {
    expect(RunState.start(RunState.Pending.make())._tag).toBe("Running");
  });

  it("a finished attempt closes the run as succeeded or failed", () => {
    const running = RunState.Running.make();
    expect(RunState.succeed(running)._tag).toBe("Succeeded");
    expect(RunState.fail(running)._tag).toBe("Failed");
  });

  it("operator retry reopens a failed run for attempt N+1", () => {
    const failed = RunState.fail(RunState.Running.make());
    expect(RunState.operatorActions(failed).canRetry).toBe(true);
    expect(RunState.retry(failed)._tag).toBe("Running");
    expect(RunState.operatorActions(RunState.retry(failed)).canRetry).toBe(false);
  });

  it("operator cancel reaches every open state and records the operator as reason", () => {
    const open: ReadonlyArray<RunState.Open> = [
      RunState.Pending.make(),
      RunState.Waiting.make(),
      RunState.Queued.make(),
      RunState.Running.make(),
    ];
    for (const state of open) {
      const canceled = RunState.cancelByOperator(state);
      expect(RunState.operatorActions(state).canCancel).toBe(true);
      expect(RunState.operatorActions(canceled).canCancel).toBe(false);
      expect(canceled._tag).toBe("Canceled");
      expect(canceled.reason._tag).toBe("OperatorCanceled");
    }
  });

  it("supersede records which Event took the run's place", () => {
    const by = EventId.make("evt-2");
    const canceled = RunState.supersede(RunState.Pending.make(), by);
    expect(canceled.reason._tag).toBe("Superseded");
    expect(canceled.reason._tag === "Superseded" && canceled.reason.by).toBe(by);
  });

  it("revoke records its own reason, distinct from operator cancel and supersede", () => {
    const canceled = RunState.revoke(RunState.Waiting.make());
    expect(canceled.reason._tag).toBe("Revoked");
    expect(RunState.revoke(RunState.Queued.make()).reason._tag).toBe("Revoked");
  });

  it("only pending, waiting, queued and running are open", () => {
    expect(RunState.isOpen(RunState.Pending.make())).toBe(true);
    expect(RunState.isOpen(RunState.Waiting.make())).toBe(true);
    expect(RunState.isOpen(RunState.Queued.make())).toBe(true);
    expect(RunState.isOpen(RunState.Running.make())).toBe(true);
    expect(RunState.isOpen(RunState.Succeeded.make())).toBe(false);
    expect(RunState.isOpen(RunState.Failed.make())).toBe(false);
    expect(RunState.isOpen(RunState.cancelByOperator(RunState.Pending.make()))).toBe(false);
  });

  // Each call below must be a type error; if one compiles, its `@ts-expect-error` is unused and
  // `tsc` fails.
  it("illegal transitions do not compile", () => {
    const pending = RunState.Pending.make();
    const waiting = RunState.Waiting.make();
    const running = RunState.Running.make();
    const succeeded = RunState.Succeeded.make();
    const failed = RunState.Failed.make();
    const canceled = RunState.cancelByOperator(pending);

    // Only a running attempt can finish.
    // @ts-expect-error a pending run has no attempt to succeed
    RunState.succeed(pending);
    // @ts-expect-error a waiting run has no attempt to fail
    RunState.fail(waiting);

    // A closed Run has no transitions except `retry` from failed.
    // @ts-expect-error a succeeded run cannot be retried
    RunState.retry(succeeded);
    // @ts-expect-error a canceled run cannot be retried
    RunState.retry(canceled);
    // @ts-expect-error only a failed run can be retried
    RunState.retry(running);
    // @ts-expect-error a succeeded run cannot be canceled
    RunState.cancelByOperator(succeeded);
    // @ts-expect-error a failed run cannot be canceled; retry it or leave it closed
    RunState.cancelByOperator(failed);
    // @ts-expect-error a closed run cannot start again
    RunState.start(canceled);

    // `supersede` and `revoke` accept only unstarted states (ADR 0007).
    // @ts-expect-error a running attempt cannot be superseded
    RunState.supersede(running, EventId.make("evt-3"));
    // @ts-expect-error a running attempt cannot be revoked
    RunState.revoke(running);
    // @ts-expect-error a closed run cannot be superseded
    RunState.supersede(succeeded, EventId.make("evt-4"));

    // The approval gate is entered only from pending and left only through `approve`.
    // @ts-expect-error only a pending run can be parked on the approval gate
    RunState.awaitApproval(running);
    // @ts-expect-error a waiting run has not passed its approval gate
    RunState.start(waiting);
    // @ts-expect-error only a waiting run can be approved
    RunState.approve(pending);
  });

  it.effect("a stored state row parses back into the same state", () =>
    Effect.gen(function* () {
      const canceled = RunState.supersede(RunState.Waiting.make(), EventId.make("evt-9"));
      const encoded = yield* Schema.encodeEffect(RunState.RunState)(canceled);
      const decodedValue1 = yield* decodeRunState(encoded);
      expect(decodedValue1).toEqual(canceled);
    }),
  );

  it.effect("a state row with an unknown tag is rejected", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(decodeRunState({ _tag: "Paused" })))._tag).toBe("SchemaError");
    }),
  );
});
