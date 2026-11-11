import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import {
  AgentFailure,
  AttemptFailure,
  BlockedFailure,
  ChildSessionBudgetFailure,
  InfraFailure,
  ProviderCapacityFailure,
  QuestionFailure,
} from "@usine/core/attempt/failure";
import { type Brand, Match, Option, Schema } from "effect";

/** The supplemental context of an Attempt's first child. */
export const FIRST_ASSIGNMENT =
  "Complete the delegated task in this checkout and give the result as your final answer.";

/** The default supplemental context of a child that replaces the previous one. */
export const REPLACEMENT_ASSIGNMENT =
  "The previous child session stopped before it finished, and it couldn't resume. The checkout keeps everything it did: inspect the checkout and continue the task from its current state.";

/** The Attempt's message when its child finished with a blank report. */
export const BLANK_REPORT_MESSAGE = "The child session finished without a report";

/** The reserved marker that a child's final report starts with: blocker, question, or harness failure. */
export const ReservedKind = Schema.Literals(["blocked", "question", "failed"]);
export type ReservedKind = typeof ReservedKind.Type;

/** A final report that starts with a reserved marker. */
export class ReservedReport extends Schema.Class<
  ReservedReport,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/ReservedReport">
>("@usine/durable/coordinator/ReservedReport")({
  kind: ReservedKind,
  /** The report text after the marker. */
  message: Schema.NonEmptyString,
}) {}

/** The Attempt started and has no child yet. */
export class AttemptStarted extends Schema.TaggedClass<
  AttemptStarted,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/AttemptStarted">
>("@usine/durable/coordinator/AttemptStarted")("AttemptStarted", {}) {}

/** Child `child` finished its work with a final report. */
export class ChildReported extends Schema.TaggedClass<
  ChildReported,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/ChildReported">
>("@usine/durable/coordinator/ChildReported")("ChildReported", {
  child: ChildSessionCount,
  report: Schema.String,
  /** Whether the turn that produced the report started from an operator message (ADR 0018). */
  answeredOperator: Schema.Boolean,
  /** The report's reserved marker, or `None` for an ordinary report. */
  reserved: Schema.OptionFromNullOr(ReservedReport),
}) {}

/** Child `child` stopped and can't resume: no saved session, worker or checkout gone, or resume refused. */
export class ChildInterrupted extends Schema.TaggedClass<
  ChildInterrupted,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/ChildInterrupted">
>("@usine/durable/coordinator/ChildInterrupted")("ChildInterrupted", {
  child: ChildSessionCount,
  reason: Schema.NonEmptyString,
}) {}

/** The model provider of child `child` refused it for lack of capacity. */
export class ChildAtCapacity extends Schema.TaggedClass<
  ChildAtCapacity,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/ChildAtCapacity">
>("@usine/durable/coordinator/ChildAtCapacity")("ChildAtCapacity", {
  child: ChildSessionCount,
  message: Schema.NonEmptyString,
}) {}

/** Child `child` failed to launch or lost its transport. */
export class ChildFailed extends Schema.TaggedClass<
  ChildFailed,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/ChildFailed">
>("@usine/durable/coordinator/ChildFailed")("ChildFailed", {
  child: ChildSessionCount,
  message: Schema.NonEmptyString,
}) {}

/** Admission refused child `child` because the Attempt's child-session budget is spent. */
export class BudgetExceeded extends Schema.TaggedClass<
  BudgetExceeded,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/BudgetExceeded">
>("@usine/durable/coordinator/BudgetExceeded")("BudgetExceeded", {
  child: ChildSessionCount,
  /** Admission's count of child requests, including the refused one. */
  attempted: ChildSessionCount,
}) {}

/** A lifecycle event of an Attempt that the coordinator handles. */
export const CoordinatorEvent = Schema.Union([
  AttemptStarted,
  ChildReported,
  ChildInterrupted,
  ChildAtCapacity,
  ChildFailed,
  BudgetExceeded,
]);
export type CoordinatorEvent = typeof CoordinatorEvent.Type;

type ChildEvent = Exclude<CoordinatorEvent, AttemptStarted>;

/** What a handler knows when it decides about `event`. */
export class AttemptContext extends Schema.Class<
  AttemptContext,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/AttemptContext">
>("@usine/durable/coordinator/AttemptContext")({
  /** The event being handled, always about the Attempt's latest child. */
  event: CoordinatorEvent,
  maxChildren: ChildSessionBudget,
}) {}

/** Starts the Attempt's first child. */
const StartChild = Schema.TaggedStruct("StartChild", {});

/** Completes the Attempt; `message` defaults to the child's report. */
export const Complete = Schema.TaggedStruct("Complete", {
  message: Schema.optionalKey(Schema.NonEmptyString),
});

/** Replaces the child; `assignment` defaults to `REPLACEMENT_ASSIGNMENT`. */
export const RetryChild = Schema.TaggedStruct("RetryChild", {
  assignment: Schema.optionalKey(Schema.NonEmptyString),
});

/** Fails the Attempt with an unresolved blocker; `message` defaults to the child's report. */
export const Blocked = Schema.TaggedStruct("Blocked", {
  message: Schema.optionalKey(Schema.NonEmptyString),
});

/** Fails the Attempt with a question for the operator. */
export const Question = Schema.TaggedStruct("Question", { question: Schema.NonEmptyString });

/** Fails the Attempt with a failure that waits for the operator. */
export const Failed = Schema.TaggedStruct("Failed", { message: Schema.NonEmptyString });

/** Fails the Attempt with an infrastructure failure, which the engine retries from salvage. */
export const InfraFailed = Schema.TaggedStruct("InfraFailed", { message: Schema.NonEmptyString });

/** Fails the Attempt with a provider capacity refusal, which the engine retries after a delay. */
export const AtCapacity = Schema.TaggedStruct("AtCapacity", { message: Schema.NonEmptyString });

/** Fails the Attempt because admission refused a child over the budget. */
const OverBudget = Schema.TaggedStruct("OverBudget", { attempted: ChildSessionCount });

/**
 * A handler's answer to one event, from a rule or a model. `clamp` checks it against the event,
 * so free text is optional wherever the event supplies it.
 */
export const Decision = Schema.Union([
  StartChild,
  Complete,
  RetryChild,
  Blocked,
  Question,
  Failed,
  InfraFailed,
  AtCapacity,
  OverBudget,
]);
export type Decision = typeof Decision.Type;

const AttemptCompleted = Schema.TaggedStruct("AttemptCompleted", {
  message: Schema.NonEmptyString,
  answeredOperator: Schema.Boolean,
});

const AttemptFailed = Schema.TaggedStruct("AttemptFailed", { failure: AttemptFailure });

const TerminalOutcome = Schema.Union([AttemptCompleted, AttemptFailed]);
type TerminalOutcome = typeof TerminalOutcome.Type;

const Start = Schema.TaggedStruct("Start", {});

const Replace = Schema.TaggedStruct("Replace", {
  replaces: ChildSessionCount,
  assignment: Schema.NonEmptyString,
});

const Settle = Schema.TaggedStruct("Settle", {
  /** The child whose event this outcome answers. */
  answering: ChildSessionCount,
  outcome: TerminalOutcome,
});

/** A decision that `clamp` checked against its event, with every default resolved. */
const ClampedDecision = Schema.Union([Start, Replace, Settle]);
export type ClampedDecision = typeof ClampedDecision.Type;

const Delegate = Schema.TaggedStruct("Delegate", {
  /** The child's 1-based number in the Attempt, which is also its child-session budget slot. */
  child: ChildSessionCount,
  assignment: Schema.NonEmptyString,
});

const Finish = Schema.TaggedStruct("Finish", { outcome: TerminalOutcome });

/** An effect that runs after its transition commits: start a child or finish the Attempt. */
export const EffectIntent = Schema.Union([Delegate, Finish]);
export type EffectIntent = typeof EffectIntent.Type;

/** The Attempt hasn't started its first child. */
export class AwaitingStart extends Schema.TaggedClass<
  AwaitingStart,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/AwaitingStart">
>("@usine/durable/coordinator/AwaitingStart")("AwaitingStart", {}) {}

class Delegating extends Schema.TaggedClass<
  Delegating,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/Delegating">
>("@usine/durable/coordinator/Delegating")("Delegating", {
  /** The latest child, whose events the coordinator handles. */
  child: ChildSessionCount,
}) {}

class Settled extends Schema.TaggedClass<
  Settled,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/Settled">
>("@usine/durable/coordinator/Settled")("Settled", { outcome: TerminalOutcome }) {}

/** The coordinator's state, committed with each transition. */
export const CoordinatorState = Schema.Union([AwaitingStart, Delegating, Settled]);
export type CoordinatorState = typeof CoordinatorState.Type;

const reservedDecision = {
  blocked: (message) => Blocked.make({ message }),
  question: (question) => Question.make({ question }),
  failed: (message) => Failed.make({ message }),
} satisfies { readonly [Kind in ReservedKind]: (message: string) => Decision };

/** Returns the rule's decision for `event`. */
export const ruleFor = (event: CoordinatorEvent, context: AttemptContext): Decision =>
  Match.valueTags(event, {
    AttemptStarted: (): Decision => StartChild.make({}),
    ChildReported: ({ reserved }): Decision =>
      Option.match(reserved, {
        onNone: () => Complete.make({}),
        onSome: ({ kind, message }) => reservedDecision[kind](message),
      }),
    ChildInterrupted: ({ child, reason }): Decision =>
      child < context.maxChildren
        ? RetryChild.make({})
        : InfraFailed.make({
            message: `Child ${child} was interrupted and couldn't resume, and the ${context.maxChildren}-child budget has no room for a replacement: ${reason}`,
          }),
    ChildAtCapacity: ({ message }): Decision => AtCapacity.make({ message }),
    ChildFailed: ({ message }): Decision => InfraFailed.make({ message }),
    BudgetExceeded: ({ attempted }): Decision => OverBudget.make({ attempted }),
  });

/** Whether a model may answer `event`; every other event takes its rule, so typed facts win. */
const modelEligible = (event: ChildEvent): boolean =>
  event._tag === "ChildInterrupted" ||
  (event._tag === "ChildReported" && Option.isNone(event.reserved));

const defaultMessage = (event: ChildEvent): string => {
  if (event._tag === "ChildReported")
    return event.report.trim() === "" ? BLANK_REPORT_MESSAGE : event.report;
  if (event._tag === "ChildInterrupted")
    return `Child ${event.child} was interrupted: ${event.reason}`;
  if (event._tag === "BudgetExceeded")
    return `Admission refused child ${event.child} over the child-session budget`;
  return event.message;
};

const resolve = (
  decision: Decision,
  event: ChildEvent,
  context: AttemptContext,
): ClampedDecision => {
  const settle = (outcome: TerminalOutcome) => Settle.make({ answering: event.child, outcome });
  const fail = (failure: AttemptFailure) => settle(AttemptFailed.make({ failure }));
  const byRule = () => resolve(ruleFor(event, context), event, context);
  return Match.valueTags(decision, {
    // Only a rule starts an Attempt or reports admission's count.
    StartChild: byRule,
    OverBudget: ({ attempted }) =>
      event._tag === "BudgetExceeded"
        ? fail(
            ChildSessionBudgetFailure.make({
              maxChildren: context.maxChildren,
              attemptedChildren: attempted,
            }),
          )
        : byRule(),
    RetryChild: ({ assignment }): ClampedDecision =>
      event.child < context.maxChildren
        ? Replace.make({ replaces: event.child, assignment: assignment ?? REPLACEMENT_ASSIGNMENT })
        : fail(
            AgentFailure.make({
              message: `Child ${event.child} needed a replacement, but the Attempt has used its ${context.maxChildren}-child budget`,
            }),
          ),
    Complete: ({ message }) =>
      settle(
        AttemptCompleted.make({
          message: message ?? defaultMessage(event),
          answeredOperator: event._tag === "ChildReported" && event.answeredOperator,
        }),
      ),
    Blocked: ({ message }) =>
      fail(BlockedFailure.make({ message: message ?? defaultMessage(event) })),
    Question: ({ question }) => fail(QuestionFailure.make({ question })),
    Failed: ({ message }) => fail(AgentFailure.make({ message })),
    InfraFailed: ({ message }) => fail(InfraFailure.make({ message, cause: message })),
    AtCapacity: ({ message }) => fail(ProviderCapacityFailure.make({ message })),
  });
};

/**
 * Checks `decision` against `context.event`. A reserved marker and the other typed facts keep their
 * rule over any decision, and a replacement past the child-session budget becomes `Failed`.
 */
export const clamp = (decision: Decision, context: AttemptContext): ClampedDecision => {
  const { event } = context;
  if (event._tag === "AttemptStarted") return Start.make({});
  return resolve(modelEligible(event) ? decision : ruleFor(event, context), event, context);
};

type Transition = readonly [CoordinatorState, ReadonlyArray<EffectIntent>];

/**
 * Returns the next state and the effect intents for `decision`. A decision about a child other
 * than the latest one, a repeated start, and anything after the Attempt settled change nothing,
 * so each interruption gets at most one replacement.
 */
export const apply = (state: CoordinatorState, decision: ClampedDecision): Transition => {
  if (state._tag === "Settled") return [state, []];
  if (decision._tag === "Start") {
    if (state._tag !== "AwaitingStart") return [state, []];
    const child = ChildSessionCount.make(1);
    return [Delegating.make({ child }), [Delegate.make({ child, assignment: FIRST_ASSIGNMENT })]];
  }
  const answered = decision._tag === "Replace" ? decision.replaces : decision.answering;
  if (state._tag !== "Delegating" || state.child !== answered) return [state, []];
  if (decision._tag === "Replace") {
    const child = ChildSessionCount.make(decision.replaces + 1);
    return [
      Delegating.make({ child }),
      [Delegate.make({ child, assignment: decision.assignment })],
    ];
  }
  return [
    Settled.make({ outcome: decision.outcome }),
    [Finish.make({ outcome: decision.outcome })],
  ];
};
