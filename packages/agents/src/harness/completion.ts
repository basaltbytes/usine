import type { AgentSessionId, SessionTokensUpdated } from "@usine/core/agent/session";
import { Effect, Option, Schema } from "effect";
import {
  type AgentResultError,
  type PoolUnavailableError,
  SessionOperationError,
  type UnknownModelError,
  type UnsupportedEffortError,
} from "../runtime.ts";
import { admitBrain } from "./admission.ts";
import {
  type Completion,
  type CompletionError,
  CompletionInvalid,
  type CompletionOutput,
  CompletionRefused,
  type SessionSpec,
} from "./contract.ts";
import type { HarnessCatalog } from "./harness.ts";

/** The JSON Schema of a completion's value, as a harness receives it. */
export const CompletionSchema = Schema.Record(Schema.String, Schema.Json);
export type CompletionSchema = typeof CompletionSchema.Type;

/**
 * The JSON Schema that constrains a completion's value to `output`. Objects are closed, because
 * strict provider modes require it, and named definitions move under `$defs`, where the
 * references point.
 */
const completionJsonSchema = (
  output: CompletionOutput<unknown>,
): Effect.Effect<CompletionSchema> => {
  const document = Schema.toJsonSchemaDocument(output, { onExcessProperty: "error" });
  return Schema.decodeUnknownEffect(CompletionSchema)(
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  ).pipe(Effect.orDie);
};

/**
 * Admits the brain of `spec` for a structured completion. The role must return a structured value
 * and keep no conversation, so admission requires `structured-output` and `ephemeral`, and the
 * output's JSON form must be an object.
 */
export const admitCompletion = Effect.fn("HarnessAdmission.completion")(function* (
  catalog: HarnessCatalog,
  spec: SessionSpec,
  output: CompletionOutput<unknown>,
) {
  const { role, context } = spec.admitted;
  const brain = spec.session.brain;
  yield* Effect.annotateCurrentSpan({
    sessionId: spec.session.id,
    role: role.name,
    worker: spec.worker,
    harness: brain.harness,
  });
  const refuse = (message: string) =>
    Effect.logWarning("Structured completion refused", {
      sessionId: spec.session.id,
      role: role.name,
      harness: brain.harness,
      message,
    }).pipe(
      Effect.andThen(Effect.fail(CompletionRefused.make({ sessionId: spec.session.id, message }))),
    );
  if (role.output !== "structured" || role.persistence !== "ephemeral")
    return yield* refuse(
      `${role.name} must return a structured value and keep no conversation to run a completion`,
    );
  const schema = yield* completionJsonSchema(output);
  if (schema.type !== "object")
    return yield* refuse("A completion's output schema must describe a JSON object");
  const admitted = admitBrain(catalog, role, brain, context);
  if (admitted._tag === "Failure") return yield* refuse(admitted.failure.message);
  yield* Effect.logInfo("Structured completion admitted", {
    sessionId: spec.session.id,
    role: role.name,
    harness: brain.harness,
    credentialRoute: context.credential,
    placement: context.placement,
  });
});

/** The JSON value that a harness returned for a completion, before `output` decodes it. */
export interface CompletionJson {
  readonly value: Schema.Json;
  readonly usage: SessionTokensUpdated;
}

/** Decodes the value that a harness returned with `output`, rejecting properties it doesn't model. */
const decodeCompletion = <A>(
  sessionId: AgentSessionId,
  output: CompletionOutput<A>,
  value: Schema.Json,
): Effect.Effect<A, CompletionInvalid> =>
  Schema.decodeEffect(Schema.toCodecJson(output))(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) =>
      CompletionInvalid.make({
        sessionId,
        message: `The completion doesn't match its output schema: ${error.message}`,
      }),
    ),
  );

/**
 * Returns a runtime's `complete` from `run`, which sends the prompt with the JSON Schema of the
 * output and returns the harness's JSON value. The value then decodes with the output schema.
 */
export const structuredCompletion =
  (
    run: (
      spec: SessionSpec,
      prompt: string,
      schema: CompletionSchema,
    ) => Effect.Effect<CompletionJson, CompletionError>,
  ) =>
  <A>(
    spec: SessionSpec,
    prompt: string,
    output: CompletionOutput<A>,
  ): Effect.Effect<Completion<A>, CompletionError> =>
    completionJsonSchema(output).pipe(
      Effect.flatMap((schema) => run(spec, prompt, schema)),
      Effect.flatMap(({ value, usage }) =>
        decodeCompletion(spec.session.id, output, value).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Structured completion rejected", {
              sessionId: spec.session.id,
              harness: spec.session.brain.harness,
              message: error.message,
            }),
          ),
          Effect.tap(() =>
            Effect.logInfo("Structured completion finished", {
              sessionId: usage.session.id,
              harness: usage.session.brain.harness,
              model: usage.session.brain.model,
              pool: Option.getOrUndefined(usage.session.pool),
              totalTokens: usage.totalTokens,
              costUsd: Option.getOrUndefined(usage.costUsd),
            }),
          ),
          Effect.map((decoded): Completion<A> => ({ value: decoded, usage })),
        ),
      ),
    );

/** Parses a harness's final answer as the JSON value of a completion. */
export const completionText = (
  sessionId: AgentSessionId,
  text: string,
): Effect.Effect<Schema.Json, CompletionInvalid> =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
    Effect.mapError(() =>
      CompletionInvalid.make({ sessionId, message: "The completion's final answer isn't JSON" }),
    ),
  );

/** A harness launch failure that the same request repeats: an unknown model, effort, or pool. */
export const refusedLaunch = (
  sessionId: AgentSessionId,
  error: UnknownModelError | UnsupportedEffortError | PoolUnavailableError,
): CompletionRefused => CompletionRefused.make({ sessionId, message: error.message });

/** A harness failure that is not a capacity refusal, as the operation error of a completion. */
export const failedCompletion = (error: AgentResultError): SessionOperationError =>
  SessionOperationError.make({
    operation: "stream",
    sessionId: error.sessionId,
    message: error.message,
    cause: error,
  });
