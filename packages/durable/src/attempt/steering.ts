import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Option, Schema } from "effect";
import type { DurableHarness } from "../harness.ts";
import { type AttemptRecord, AttemptRecordDoc, HoldDoc } from "./documents.ts";
import type { AttemptHub } from "./hubs.ts";
import { parentSessionId } from "./parent.ts";

const encodeIntervention = Schema.encodeSync(AttemptChannel.Intervention);

export const hasPendingForwardedSteer = (record: Readonly<AttemptRecord>): boolean =>
  (record.queuedInputs ?? []).some(
    (input) =>
      "child" in input &&
      input.intervention.target._tag === "Parent" &&
      input.intervention.action._tag === "Steer",
  );

/** Queues a separate parent turn so a child's earlier answer cannot complete the attempt. */
export const queueParentSteer = Effect.fn("AttemptSteering.queueParent")(function* (
  durable: DurableHarness["Service"],
  hub: AttemptHub,
  inputSequence: AttemptChannel.Sequence,
  operator: string,
  steer: AttemptChannel.Steer,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: hub.attemptId, inputSequence });
  const requestId = `intervention:${hub.attemptId}:${inputSequence}`;
  const intervention = new AttemptChannel.Intervention({
    operator,
    target: new AttemptChannel.ParentTarget(),
    action: steer,
  });
  const state = yield* durable.use("queue a parent turn for the steer", (harness, context) =>
    harness.commit(async (tx) => {
      const task = await tx.task(hub.taskId);
      if (task === undefined || task.state.status === "terminal") return Option.none();
      const hold = await tx.doc(HoldDoc, hub.taskId);
      const record = await tx.doc(AttemptRecordDoc, hub.attemptId, null);
      if (!hold.guidance.some((item) => item.requestId === requestId)) {
        hold.guidance.push({
          requestId,
          message: [
            `Operator steer from ${operator}:\n${steer.message}`,
            "The steer was not delivered to a child. Act on it before your final answer: delegate the remaining work or answer the operator. Do not return the previous child result unchanged.",
          ].join("\n\n"),
        });
      }
      hold.paused = false;
      record.queuedInputs = [
        ...(record.queuedInputs ?? []).filter((input) => input.inputSequence !== inputSequence),
        { inputSequence, requestId, intervention: encodeIntervention(intervention) },
      ];
      return Option.some(
        new AttemptChannel.InterventionState({
          held: hold.held.includes(parentSessionId(hub.attemptId)),
          paused: false,
          queued: true,
        }),
      );
    }, context),
  );
  yield* Effect.logInfo(
    Option.isSome(state)
      ? "Queued a separate parent turn for an unforwarded steer"
      : "The attempt ended before the steer could be queued for its parent",
    { inputSequence },
  );
  return state;
});
