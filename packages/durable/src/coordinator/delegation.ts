import type { ChildRequest } from "@usine/agents/runtime";
import type { ChildSessionCount } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import { Effect, Schema } from "effect";

import type {
  DelegationCall,
  DelegationJournal,
  SavedChild,
} from "../attempt/delegation/journal.ts";
import {
  type AttemptJournal,
  ContinuationsSaved,
  IdleSaved,
  OutputSaved,
  type ProgressChange,
  Prompted,
  SessionSaved,
  ToolFinished,
  ToolStarted,
  UsageSaved,
} from "./journal.ts";

/** The characters of a child's output that the coordinator retains, from its end. */
const RETAINED_OUTPUT_CHARACTERS = 50_000;

// Encoded values of these schemas are JSON.
const asJson = (
  value: typeof SavedChild.Encoded | typeof ChildRequest.fields.usage.Encoded,
): Effect.Effect<Schema.Json> => Schema.decodeEffect(Schema.Json)(value).pipe(Effect.orDie);

/**
 * The journal of delegation `number`, which the transition that decided it numbered within the
 * child-session budget, so `start` never refuses it. The coordinator refuses operator input, so no
 * child is held or paused and none has queued input.
 */
export const journalDelegation = (
  journal: AttemptJournal["Service"],
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
    queuedInputs: () => Effect.succeed([]),
    supervision: () => Effect.succeed({ held: false, paused: false }),
    holdEnded: () => Effect.void,
    releaseSupervision: () => Effect.void,
    saveSession: (saved, { beforePrompt }) =>
      asJson(saved).pipe(
        Effect.flatMap((json) => save(SessionSaved.make({ saved: json, beforePrompt }))),
      ),
    savePrompted: save(Prompted.make({})),
    saveContinuations: (timestamps) => save(ContinuationsSaved.make({ timestamps })),
    saveUsage: (usage) =>
      asJson(usage).pipe(Effect.flatMap((json) => save(UsageSaved.make({ usage: json })))),
    toolStarted: (callId, tool) => save(ToolStarted.make({ callId, tool })),
    toolFinished: (callId) => save(ToolFinished.make({ callId })),
    saveIdle: (report) => save(IdleSaved.make({ report })),
    saveOutput: (output) => save(OutputSaved.make({ output })),
  };
};

/**
 * One delegation that the coordinator runs. It keeps the end of the child's output in memory and
 * ends when `aborted` completes. The coordinator turns the delegation's outcome into its next
 * event, so a reserved report or an infrastructure failure needs no record here.
 */
export const coordinatorCall = (aborted: Effect.Effect<void>): DelegationCall => {
  let output = "";
  return {
    output: (chunk) =>
      Effect.sync(() => {
        output = `${output}${chunk}`.slice(-RETAINED_OUTPUT_CHARACTERS);
      }),
    retainedOutput: Effect.sync(() => output),
    // No tool call shows the delegation's details.
    publish: () => Effect.void,
    aborted,
    infrastructureFailed: () => Effect.void,
    reserved: () => Effect.void,
    recovered: () => Effect.void,
  };
};
