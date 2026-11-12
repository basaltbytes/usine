import { type AgentSessionId, SessionTokensUpdated, TokenCount } from "@usine/core/agent/session";
import { Data, Effect, type JsonSchema, Option, Predicate, Ref, Schema, type Scope } from "effect";
import {
  type AgentCapacityError,
  type AgentResultError,
  type PoolUnavailableError,
  SessionOperationError,
  type UnknownModelError,
  type UnsupportedEffortError,
} from "../runtime.ts";
import { admitBrain } from "./admission.ts";
import {
  type Completion,
  CompletionError,
  type CompletionFailure,
  CompletionInvalid,
  type CompletionOutput,
  CompletionRefused,
  type SessionSpec,
} from "./contract.ts";
import type { HarnessCatalog } from "./harness.ts";

/** The JSON Schema of a completion's value, as a harness receives it. */
export const CompletionSchema = Schema.Record(Schema.String, Schema.Json);
export type CompletionSchema = typeof CompletionSchema.Type;

const DEFINITIONS = "#/$defs/";

/** The definition name that a root `{"$ref": "#/$defs/<name>"}` points to. */
const rootReference = (schema: JsonSchema.JsonSchema): Option.Option<string> => {
  const keys = Object.keys(schema);
  const ref = schema.$ref;
  return keys.length === 1 && Predicate.isString(ref) && ref.startsWith(DEFINITIONS)
    ? Option.some(ref.slice(DEFINITIONS.length).replaceAll("~1", "/").replaceAll("~0", "~"))
    : Option.none();
};

/**
 * The JSON Schema that constrains a completion's value to `output`. Objects are closed, because
 * strict provider modes require it, and named definitions move under `$defs`, where the
 * references point. A root that only references a definition, as an identified schema or a
 * `Schema.Class` has, is replaced by a copy of that definition, because a harness reads the
 * root's type. The definition stays under `$defs` for the references inside it.
 */
const completionJsonSchema = (
  output: CompletionOutput<unknown>,
): Effect.Effect<CompletionSchema> => {
  const document = Schema.toJsonSchemaDocument(output, { onExcessProperty: "error" });
  const root = Option.getOrElse(
    Option.flatMap(rootReference(document.schema), (name) =>
      Option.fromUndefinedOr(document.definitions[name]),
    ),
    () => document.schema,
  );
  return Schema.decodeUnknownEffect(CompletionSchema)(
    Object.keys(document.definitions).length === 0
      ? root
      : { ...root, $defs: document.definitions },
  ).pipe(Effect.orDie);
};

const failed = (
  sessionId: AgentSessionId,
  reason: CompletionFailure,
  usage: Option.Option<SessionTokensUpdated>,
): CompletionError => CompletionError.make({ sessionId, reason, usage, message: reason.message });

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
      Effect.andThen(
        Effect.fail(
          failed(
            spec.session.id,
            CompletionRefused.make({ sessionId: spec.session.id, message }),
            Option.none(),
          ),
        ),
      ),
    );
  if (role.output !== "structured" || role.persistence !== "ephemeral")
    return yield* refuse(
      `${role.name} must return a structured value and keep no conversation to run a completion`,
    );
  if (role.hostTools)
    return yield* refuse(
      `The ${role.name} role runs a usine tool set, but a completion serves no usine tools`,
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

/** How long a structured completion may run before it fails as a stalled operation. */
const COMPLETION_TIMEOUT = "10 minutes";

/** What a harness answered to one completion request. */
export type CompletionReply = Data.TaggedEnum<{
  /** A JSON value that the harness returned for the schema. */
  Value: { readonly value: Schema.Json };
  /** A final answer whose text is the JSON value. */
  Answer: { readonly text: string };
  /** The model declined to answer. */
  Declined: { readonly message: string };
  /** The harness finished the request without a value. */
  Missing: { readonly message: string };
}>;
export const CompletionReply = Data.taggedEnum<CompletionReply>();

/** How a harness failed a completion: its launch, process, transport, or result failures. */
export type HarnessCompletionError =
  | UnknownModelError
  | UnsupportedEffortError
  | PoolUnavailableError
  | AgentResultError
  | AgentCapacityError
  | SessionOperationError;

/** One completion request, as a harness adapter runs it. */
export interface CompletionRequest {
  readonly spec: SessionSpec;
  readonly prompt: string;
  /** The JSON Schema of the value, with closed objects. */
  readonly schema: CompletionSchema;
  /**
   * Records the completion's cumulative usage, which replaces the last report. Report the zero
   * usage of the resolved session before the model request, then each update, so that a failure
   * carries what the request spent.
   */
  readonly spent: (usage: SessionTokensUpdated) => Effect.Effect<void>;
}

/**
 * Returns why the harness outcome `error` leaves a completion without a value. A model, effort,
 * or pool that the harness rules out is a refusal, because the same request fails the same way.
 */
const failureOf = (sessionId: AgentSessionId, error: HarnessCompletionError): CompletionFailure => {
  switch (error._tag) {
    case "UnknownModelError":
    case "UnsupportedEffortError":
    case "PoolUnavailableError":
      return CompletionRefused.make({ sessionId, message: error.message });
    case "AgentResultError":
      return SessionOperationError.make({
        operation: "stream",
        sessionId: error.sessionId,
        message: error.message,
        cause: error,
      });
    case "AgentCapacityError":
    case "SessionOperationError":
      return error;
  }
};

/** Parses a final answer as JSON and decodes it with `output`, rejecting unmodeled properties. */
const valueOf = <A>(
  sessionId: AgentSessionId,
  output: CompletionOutput<A>,
  reply: CompletionReply,
): Effect.Effect<A, CompletionInvalid | CompletionRefused> =>
  CompletionReply.$match(reply, {
    Value: ({ value }) => Effect.succeed(value),
    Answer: ({ text }) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
        Effect.mapError(() =>
          CompletionInvalid.make({
            sessionId,
            message: "The completion's final answer isn't JSON",
          }),
        ),
      ),
    Declined: ({ message }) => Effect.fail(CompletionRefused.make({ sessionId, message })),
    Missing: ({ message }) => Effect.fail(CompletionInvalid.make({ sessionId, message })),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeEffect(Schema.toCodecJson(output))(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError((error) =>
          CompletionInvalid.make({
            sessionId,
            message: `The completion doesn't match its output schema: ${error.message}`,
          }),
        ),
      ),
    ),
  );

/**
 * Returns a runtime's `complete` from `run`, which sends the prompt with the JSON Schema of the
 * output and returns what the harness answered. Every outcome is classified, logged, and given
 * the usage that the harness reported here, so each adapter deals only in its harness's outcomes.
 * A `run` that answers nothing within 10 minutes is interrupted, and the completion fails with a
 * `SessionOperationError` reason and the usage reported before then.
 */
export const structuredCompletion =
  (
    run: (
      request: CompletionRequest,
    ) => Effect.Effect<CompletionReply, HarnessCompletionError, Scope.Scope>,
  ) =>
  <A>(
    spec: SessionSpec,
    prompt: string,
    output: CompletionOutput<A>,
  ): Effect.Effect<Completion<A>, CompletionError> =>
    Effect.gen(function* () {
      const sessionId = spec.session.id;
      const spent = yield* Ref.make(Option.none<SessionTokensUpdated>());
      const schema = yield* completionJsonSchema(output);
      const outcome = yield* run({
        spec,
        prompt,
        schema,
        spent: (usage) => Ref.set(spent, Option.some(usage)),
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: COMPLETION_TIMEOUT,
          orElse: () =>
            Effect.logError("Structured completion timed out", {
              sessionId,
              harness: spec.session.brain.harness,
              timeout: COMPLETION_TIMEOUT,
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  SessionOperationError.make({
                    operation: "stream",
                    sessionId: Option.some(sessionId),
                    message: `${spec.session.brain.harness} returned no completion within ${COMPLETION_TIMEOUT}`,
                    cause: new Error("completion timed out"),
                  }),
                ),
              ),
            ),
        }),
        Effect.mapError((error) => failureOf(sessionId, error)),
        Effect.flatMap((reply) => valueOf(sessionId, output, reply)),
        Effect.result,
      );
      const usage = yield* Ref.get(spent);
      if (outcome._tag === "Failure") {
        const reason = outcome.failure;
        yield* Effect.logWarning("Structured completion failed", {
          sessionId,
          harness: spec.session.brain.harness,
          reason: reason._tag,
          message: reason.message,
          totalTokens: Option.getOrUndefined(Option.map(usage, (spent) => spent.totalTokens)),
          costUsd: Option.getOrUndefined(Option.flatMap(usage, (spent) => spent.costUsd)),
        });
        return yield* failed(sessionId, reason, usage);
      }
      const reported = Option.getOrElse(usage, () =>
        SessionTokensUpdated.make({ session: spec.session, totalTokens: TokenCount.make(0) }),
      );
      yield* Effect.logInfo("Structured completion finished", {
        sessionId: reported.session.id,
        harness: reported.session.brain.harness,
        model: reported.session.brain.model,
        pool: Option.getOrUndefined(reported.session.pool),
        totalTokens: reported.totalTokens,
        costUsd: Option.getOrUndefined(reported.costUsd),
      });
      return { value: outcome.success, usage: reported };
    });
