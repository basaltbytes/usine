import type { JsonValue } from "@earendil-works/chord";
import { RunSpec } from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { Effect, Schema } from "effect";
import type { AttemptRequest } from "../attempt-runtime.ts";

/**
 * What the `usine.attempt` task stores of its request. The environment is left
 * out because it carries the Attempt's credential configuration; children get
 * it from the `execute` call currently relaying the Attempt.
 */
export class StoredRequest extends Schema.Class<StoredRequest>("@usine/durable/StoredRequest")({
  spec: RunSpec,
  worker: WorkerName,
  cwd: Schema.NonEmptyString,
}) {}

/** The `usine.attempt` task's input: its stored request as JSON. */
export type AttemptTaskInput = { request: string };

const storedJson = Schema.fromJsonString(StoredRequest);
const encodeStored = Schema.encodeSync(storedJson);
const decodeInput = Schema.decodeUnknownEffect(Schema.Struct({ request: storedJson }));

export const taskInput = (request: AttemptRequest): AttemptTaskInput => ({
  request: encodeStored(
    new StoredRequest({ spec: request.spec, worker: request.worker, cwd: request.cwd }),
  ),
});

/** Decodes a stored task input; a malformed one is a defect, since only this package writes it. */
export const storedRequestOf = (input: JsonValue): Effect.Effect<StoredRequest> =>
  decodeInput(input).pipe(
    Effect.map(({ request }) => request),
    Effect.orDie,
  );
