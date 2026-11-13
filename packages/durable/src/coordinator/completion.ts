import {
  admitBrain,
  RolePlacements,
  RoleSpec,
  workerAdmissionContext,
} from "@usine/agents/harness";
import { type CompletionError, SessionSpec } from "@usine/agents/harness/contract";
import { Harnesses } from "@usine/agents/harness/registry";
import { WorkingDirectory } from "@usine/agents/runtime";
import { BrainSpec } from "@usine/core/agent/brain";
import {
  RoleName,
  RoleSession,
  sessionPool,
  type SessionTokensUpdated,
} from "@usine/core/agent/session";
import { Effect, Layer, Match, Option, Result, Schema } from "effect";

import {
  AtCapacity,
  type AttemptContext,
  Blocked,
  clampRejection,
  Complete,
  type CoordinatorEvent,
  Failed,
  InfraFailed,
  type ModelDecision,
  modelEligible,
  Question,
  RetryChild,
} from "../attempt/coordinator/rules.ts";
import { childSessionId, decisionSessionId } from "../attempt/sessions.ts";
import { encodeAttemptContext } from "./context.ts";
import {
  HandlerSession,
  HandlerUsage,
  RecordedDecision,
  WakeUp,
  type WakeUpAttempt,
} from "./wake-up.ts";

/**
 * The structured completion that decides an event: one schema-checked value from the agent's
 * `decision` brain, with no conversation and no usine tools. A harness that can't turn its own
 * tools off runs them without write access, so the role doesn't require closed tools.
 */
const decisionCompletion = RoleSpec.make({
  name: RoleName.make("decision-completion"),
  placement: RolePlacements.make({
    placements: ["local", "ssh", "container", "sandbox"],
    reason: "The decision runs where the Attempt's child runs, with the same credential route",
  }),
  credential: Option.none(),
  nativeTools: true,
  hostTools: false,
  persistence: "ephemeral",
  interventions: false,
  output: "structured",
});

/**
 * Text that the decision may leave to the event, as `null`, because strict modes require every key.
 * The wire schema carries no `minLength`, which strict modes may not accept, so `""` means `null`.
 */
const defaulted = Schema.NullOr(Schema.String);

/**
 * The completion's value: a `ModelDecision` whose optional fields are `null` when absent, and why
 * the model chose it. Its strings carry no length keyword; `decisionOf` checks the required ones.
 */
export const CompletionAnswer = Schema.Struct({
  decision: Schema.Union([
    Schema.TaggedStruct("Complete", { message: defaulted }),
    Schema.TaggedStruct("RetryChild", { assignment: defaulted }),
    Schema.TaggedStruct("Blocked", { message: defaulted }),
    Schema.TaggedStruct("Question", { question: Schema.String }),
    Schema.TaggedStruct("Failed", { message: Schema.String }),
    Schema.TaggedStruct("InfraFailed", { message: Schema.String }),
    Schema.TaggedStruct("AtCapacity", {
      message: Schema.String,
      resetsAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    }),
  ]),
  reason: Schema.String,
});
type CompletionAnswer = typeof CompletionAnswer.Type;

/** Whether `text` is empty or holds only whitespace. */
const blank = (text: string): boolean => text.trim() === "";

/** Whether the answer gave `text`, rather than leaving it `null` or blank. */
const given = (text: string | null): text is string => text !== null && !blank(text);

/** `text` as a required field of `tag`, or why the answer can't state it. */
const required = (tag: string, field: string, text: string): Result.Result<string, string> =>
  blank(text) ? Result.fail(`The answer's ${tag} has an empty ${field}`) : Result.succeed(text);

/**
 * Returns the `ModelDecision` that `answer` states, without the keys it left `null` or blank, or
 * why it states none: a required text is blank.
 */
const decisionOf = (answer: CompletionAnswer["decision"]): Result.Result<ModelDecision, string> =>
  Match.valueTags(answer, {
    Complete: ({ message }) =>
      Result.succeed<ModelDecision>(Complete.make(given(message) ? { message } : {})),
    RetryChild: ({ assignment }) =>
      Result.succeed<ModelDecision>(RetryChild.make(given(assignment) ? { assignment } : {})),
    Blocked: ({ message }) =>
      Result.succeed<ModelDecision>(Blocked.make(given(message) ? { message } : {})),
    Question: ({ question }) =>
      Result.map(required("Question", "question", question), (question): ModelDecision =>
        Question.make({ question }),
      ),
    Failed: ({ message }) =>
      Result.map(required("Failed", "message", message), (message): ModelDecision =>
        Failed.make({ message }),
      ),
    InfraFailed: ({ message }) =>
      Result.map(required("InfraFailed", "message", message), (message): ModelDecision =>
        InfraFailed.make({ message }),
      ),
    AtCapacity: ({ message, resetsAt }) =>
      Result.map(required("AtCapacity", "message", message), (message): ModelDecision =>
        AtCapacity.make(resetsAt === null ? { message } : { message, resetsAt }),
      ),
  });

const INSTRUCTIONS = `You decide what an Attempt does next. usine ran a child session of a coding agent on a task, and the child finished with the final report in \`event.report\`. The JSON below is the Attempt: the event, the start of the task, the outcome labels and CI policy that the engine checks after a success, the earlier delegations, the end of the child's output, and the child-session budget in \`maxChildren\`.

Answer with one decision and, in \`reason\`, one sentence on why:

- \`Complete\`: the child did the task. The engine then verifies the outcome labels and CI. Set \`message\` to null to complete with the child's report.
- \`RetryChild\`: the work isn't done, and another child can continue it from the checkout. Only when the latest child's number is less than \`maxChildren\`. Set \`assignment\` to what the next child must do, or to null to pass it the report.
- \`Blocked\`: the child stopped on a blocker that only the operator can remove. Set \`message\` to null to use the report.
- \`Question\`: the work needs a decision that only the operator can make. Set \`question\` to it.
- \`Failed\`: the work failed in a way that the operator must look at.
- \`InfraFailed\`: the worker, checkout, or tools failed, and running the Attempt again can fix it.
- \`AtCapacity\`: the model provider refused the child for lack of capacity. Set \`resetsAt\` to the reset time in ISO 8601 if the report gives one, else null.

Choose \`Complete\` when the report doesn't show otherwise, because the engine verifies the result.

Attempt:
`;

/** Returns the completion's prompt: the instructions and the encoded context. */
const promptFor = (context: AttemptContext) =>
  encodeAttemptContext(context).pipe(
    // Every field was validated at construction.
    Effect.orDie,
    Effect.map((encoded) => `${INSTRUCTIONS}${encoded}`),
  );

const handlerUsage = (usage: SessionTokensUpdated) =>
  HandlerUsage.make({ totalTokens: usage.totalTokens, costUsd: usage.costUsd });

const make = Effect.gen(function* () {
  const harnesses = yield* Harnesses;

  /** Logs why the rule decides `event` instead of the completion. */
  const ruleDecides = (attempt: WakeUpAttempt, event: CoordinatorEvent, reason: string) =>
    Effect.logWarning("The structured completion didn't decide the event; its rule applies", {
      attemptId: attempt.attemptId,
      sequence: attempt.sequence,
      event: event._tag,
      reason,
    }).pipe(Effect.as(Option.none<RecordedDecision>()));

  const handle = Effect.fn("WakeUp.completion")(function* (
    event: CoordinatorEvent,
    context: AttemptContext,
    attempt: WakeUpAttempt,
  ) {
    const { attemptId, sequence } = attempt;
    yield* Effect.annotateCurrentSpan({ attemptId, sequence, event: event._tag });
    if (event._tag !== "ChildReported" || !modelEligible(event)) return Option.none();
    const agent = attempt.spec.agent;
    if (Option.isNone(agent.decision)) {
      yield* Effect.logInfo("The agent has no decision brain; the event's rule applies", {
        attemptId,
        sequence,
        agent: agent.name,
      });
      return Option.none();
    }
    const brain = BrainSpec.make({
      harness: agent.brain.harness,
      model: agent.decision.value.model,
      effort: agent.decision.value.effort,
    });
    const request = yield* attempt.request;
    const gatewayCredential = yield* request.gatewayCredential;
    const admission = workerAdmissionContext(harnesses.catalog, {
      harness: brain.harness,
      host: request.host,
      environment: request.environment,
      gatewayCredential,
    });
    const admitted = admitBrain(harnesses.catalog, decisionCompletion, brain, admission);
    if (admitted._tag === "Failure")
      return yield* ruleDecides(attempt, event, admitted.failure.message);
    const runtime = yield* harnesses.runtime(brain.harness).pipe(Effect.option);
    if (Option.isNone(runtime))
      return yield* ruleDecides(attempt, event, `No runtime for harness "${brain.harness}"`);
    const spec = SessionSpec.make({
      session: RoleSession.make({
        id: decisionSessionId(attemptId, sequence),
        role: decisionCompletion.name,
        parentId: Option.some(childSessionId(attemptId, event.child)),
        agent: agent.name,
        brain,
      }),
      admitted: admitted.success,
      host: request.host,
      worker: request.worker,
      machine: request.machine,
      cwd: WorkingDirectory.make(request.cwd),
      environment: request.environment,
    });
    yield* Effect.logInfo("Asking the agent's decision brain about the child's report", {
      attemptId,
      sequence,
      child: event.child,
      sessionId: spec.session.id,
      model: brain.model,
      credentialRoute: admission.credential,
    });
    const prompt = yield* promptFor(context);
    const completion = yield* runtime.value
      .complete(spec, prompt, CompletionAnswer)
      .pipe(Effect.result);
    if (completion._tag === "Failure") {
      const error: CompletionError = completion.failure;
      if (Option.isSome(error.usage)) yield* attempt.recordUsage(error.usage.value);
      return yield* ruleDecides(attempt, event, `${error.reason._tag}: ${error.message}`);
    }
    const { value, usage } = completion.success;
    yield* attempt.recordUsage(usage);
    const stated = decisionOf(value.decision);
    if (stated._tag === "Failure") return yield* ruleDecides(attempt, event, stated.failure);
    const decision = stated.success;
    const rejection = clampRejection(decision, context);
    if (Option.isSome(rejection))
      return yield* ruleDecides(
        attempt,
        event,
        `The rules reject ${decision._tag}: ${rejection.value}`,
      );
    yield* Effect.logInfo("The structured completion decided the event", {
      attemptId,
      sequence,
      decision: decision._tag,
      reason: value.reason,
      totalTokens: usage.totalTokens,
    });
    return Option.some(
      RecordedDecision.make({
        decision,
        handler: "completion",
        session: Option.some(
          HandlerSession.make({
            brain: usage.session.brain,
            route: admission.credential,
            pool: sessionPool(usage.session),
            usage: handlerUsage(usage),
          }),
        ),
      }),
    );
  });

  return WakeUp.of({ handle });
});

/**
 * Decides a report without a reserved marker with a structured completion from the agent's
 * `decision` brain, on the agent's harness, placement, and credential route. Every other event, an
 * agent without a `decision` brain, a completion that fails, and a decision that the rules reject
 * take the event's rule.
 */
export const completionWakeUp: Layer.Layer<WakeUp, never, Harnesses> = Layer.effect(WakeUp, make);
