import type { JsonValue } from "@earendil-works/chord";
import type { AttemptId } from "@usine/core/attempt";
import { Effect, Option, Schema } from "effect";
import { type AttemptRequest, StoredRequest } from "../attempt-runtime.ts";
import type { DurableHarness } from "../harness.ts";
import { readRecord } from "./relay.ts";

/** The `usine.attempt` task's input: its `StoredRequest`, encoded, so no credential reaches storage. */
export type AttemptTaskInput = typeof StoredRequest.Encoded;

const encodeStored = Schema.encodeSync(StoredRequest);
const decodeStored = Schema.decodeUnknownEffect(StoredRequest);

export const taskInput = (request: AttemptRequest): AttemptTaskInput =>
  encodeStored(new StoredRequest({ spec: request.spec, worker: request.worker, cwd: request.cwd }));

/** Decodes a stored task input, typed or as a task record returns it; a malformed one is a defect, since only this package writes it. */
export const storedRequestOf = (input: AttemptTaskInput | JsonValue) =>
  decodeStored(input).pipe(Effect.orDie);

/** Reads back the request an Attempt's task was created with; none when the Attempt has no task. */
export const readStoredRequest = (durable: DurableHarness["Service"], attemptId: AttemptId) =>
  Effect.gen(function* () {
    const taskId = (yield* readRecord(durable, attemptId))?.taskId ?? null;
    const task =
      taskId === null
        ? undefined
        : yield* durable.use("read the Attempt task", (harness, context) =>
            harness.getTask(taskId, context),
          );
    yield* Effect.logDebug("Read the Attempt's stored request", {
      attemptId,
      found: task !== undefined,
    });
    return task === undefined ? Option.none() : Option.some(yield* storedRequestOf(task.input));
  });
