import type { ChildRequest } from "@usine/agents/runtime";
import type { ChildSessionCount } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import { Effect, Option, Schema } from "effect";

import type {
  DelegationCall,
  DelegationJournal,
  SavedChild,
} from "../attempt/delegation/journal.ts";
import {
  type AttemptJournal,
  ContinuationsSaved,
  decodeIntervention,
  Supervision,
  IdleSaved,
  Launched,
  OutputSaved,
  type ProgressChange,
  Prompted,
  ReceiptsSaved,
  SessionSaved,
  ToolFinished,
  ToolStarted,
  UsageSaved,
} from "./journal.ts";
import type { Supervisor } from "./supervision.ts";

/** The characters of a child's output that the coordinator retains, from its end. */
const RETAINED_OUTPUT_CHARACTERS = 50_000;

// Encoded values of these schemas are JSON.
const asJson = (
  value: typeof SavedChild.Encoded | typeof ChildRequest.fields.usage.Encoded,
): Effect.Effect<Schema.Json> => Schema.decodeEffect(Schema.Json)(value).pipe(Effect.orDie);

/**
 * The journal of delegation `number`, which the transition that decided it numbered within the
 * child-session budget, so `start` never refuses it. The child's supervision and queued operator
 * input come from the attempt journal.
 */
export const journalDelegation = (
  journal: AttemptJournal["Service"],
  supervisor: Supervisor,
  attemptId: AttemptId,
  number: ChildSessionCount,
): DelegationJournal => {
  const save = (change: ProgressChange) => journal.saveProgress(attemptId, number, change);
  return {
    start: journal.startDelegation(attemptId, number).pipe(
      Effect.map(({ resumed, progress }) => ({
        _tag: "Admitted" as const,
        count: number,
        resumed,
        progress,
      })),
    ),
    queuedInputs: (sessionId) =>
      journal.load(attemptId).pipe(
        Effect.flatMap((snapshot) =>
          Effect.forEach(
            Option.match(snapshot, {
              onNone: () => [],
              onSome: ({ inputs }) => inputs.filter((input) => input.sessionId === sessionId),
            }),
            (input) =>
              decodeIntervention(input.intervention).pipe(
                Effect.map((intervention) => ({
                  inputSequence: input.inputSequence,
                  intervention,
                })),
              ),
          ),
        ),
      ),
    supervision: (sessionId) =>
      supervisor.of(sessionId).pipe(Effect.map(({ held, paused }) => ({ held, paused }))),
    // A held child keeps its result until the operator releases it (`ChildRequest.held`).
    holdEnded: () => Effect.void,
    releaseSupervision: (sessionId) =>
      supervisor.supervise(Supervision.make({ sessionId, held: false, paused: false })),
    saveSession: (saved, { beforePrompt }) =>
      asJson(saved).pipe(
        Effect.flatMap((json) => save(SessionSaved.make({ saved: json, beforePrompt }))),
      ),
    savePrompted: save(Prompted.make({})),
    saveContinuations: (timestamps) => save(ContinuationsSaved.make({ timestamps })),
    saveReceipts: (items) => save(ReceiptsSaved.make({ items })),
    saveUsage: (usage) =>
      asJson(usage).pipe(Effect.flatMap((json) => save(UsageSaved.make({ usage: json })))),
    toolStarted: (callId, tool) => save(ToolStarted.make({ callId, tool })),
    toolFinished: (callId) => save(ToolFinished.make({ callId })),
    saveIdle: (report, answeredOperator) => save(IdleSaved.make({ report, answeredOperator })),
    saveOutput: (output) => save(OutputSaved.make({ output })),
    saveLaunched: save(Launched.make({})),
  };
};

/**
 * One delegation that the coordinator runs. It keeps the end of the child's output in memory,
 * runs `published` when the child is live, and ends when `aborted` completes. The coordinator
 * turns the delegation's outcome into its next event, so a reserved report or an infrastructure
 * failure needs no record here.
 */
export const coordinatorCall = (
  aborted: Effect.Effect<void>,
  published: Effect.Effect<void>,
): DelegationCall => {
  let output = "";
  return {
    output: (chunk) =>
      Effect.sync(() => {
        output = `${output}${chunk}`.slice(-RETAINED_OUTPUT_CHARACTERS);
      }),
    retainedOutput: Effect.sync(() => output),
    // No tool call shows the delegation's details; a publish means the child is live.
    publish: () => published,
    aborted,
    infrastructureFailed: () => Effect.void,
    reserved: () => Effect.void,
    recovered: () => Effect.void,
  };
};
