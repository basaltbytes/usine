import { AgentName } from "@usine/core/agent";
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
import { AWAITING_CI_MARKER } from "@usine/core/ci";
import { OutcomeLabels } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { type Brand, Match, Option, Schema } from "effect";

/** The supplemental context of an Attempt's first child. */
export const FIRST_ASSIGNMENT =
  "Complete the delegated task in this checkout and give the result as your final answer.";

/** The default supplemental context of a child that replaces an interrupted one. */
export const REPLACEMENT_ASSIGNMENT =
  "The previous child session stopped before it finished, and it couldn't resume. The checkout keeps everything it did: inspect the checkout and continue the task from its current state.";

/**
 * The default supplemental context of a child that replaces one that reported, before the
 * previous child's report.
 */
export const REPORTED_REPLACEMENT_ASSIGNMENT =
  "The previous child session finished, but its work isn't done. The checkout keeps everything it did: read its final report below, inspect the checkout, and continue the task from its current state.";

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
  /** The time the provider's usage limit resets, or `None` if the provider didn't report one. */
  resetsAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
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

/** How a delegation ended, read from the event that ended it. */
export const DelegationEnd = Schema.Literals([
  "reported",
  "blocked",
  "question",
  "failed",
  "interrupted",
  "capacity",
  "infrastructure",
  "over-budget",
]);
export type DelegationEnd = typeof DelegationEnd.Type;

/** One delegation of the Attempt as a handler sees it. */
export class DelegationSummary extends Schema.Class<
  DelegationSummary,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/DelegationSummary">
>("@usine/durable/coordinator/DelegationSummary")({
  child: ChildSessionCount,
  status: Schema.Literals(["intended", "running", "ended"]),
  end: Schema.OptionFromNullOr(DelegationEnd),
  /** The child's final report or the reason it ended, shortened. */
  report: Schema.OptionFromNullOr(Schema.String),
}) {}

/**
 * What a handler knows when it decides about `event`, read from the attempt journal. Every field
 * other than `event` is bounded; see `buildAttemptContext`.
 */
export class AttemptContext extends Schema.Class<
  AttemptContext,
  Brand.Brand<"@usine/durable/attempt/coordinator/rules/AttemptContext">
>("@usine/durable/coordinator/AttemptContext")({
  /** The event being handled, always about the Attempt's latest child. */
  event: CoordinatorEvent,
  maxChildren: ChildSessionBudget,
  repository: RepositoryName,
  agent: AgentName,
  /** The start of the rendered task. */
  task: Schema.String,
  /** The labels the engine verifies on the Item after a success. */
  outcomeLabels: OutcomeLabels,
  /** Whether the engine verifies the Attempt's pull request against the Loop's CI policy. */
  requiresCi: Schema.Boolean,
  /** The Attempt's delegations in child order, without the report that `event` carries. */
  delegations: Schema.Array(DelegationSummary),
  /** The end of the latest child's retained output. */
  output: Schema.String,
}) {}

/** Starts the Attempt's first child. */
const StartChild = Schema.TaggedStruct("StartChild", {});

/**
 * Completes the Attempt; `message` defaults to the child's report. Without `message`, an event
 * other than a report takes its rule, because it has no report to complete with.
 */
export const Complete = Schema.TaggedStruct("Complete", {
  message: Schema.optionalKey(Schema.NonEmptyString),
});

/**
 * Replaces the child; `assignment` defaults to `REPORTED_REPLACEMENT_ASSIGNMENT` with the child's
 * report, or to `REPLACEMENT_ASSIGNMENT` for an interruption.
 */
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

/**
 * Fails the Attempt with a provider capacity refusal, which the engine retries after a delay, or at
 * `resetsAt` if the provider reported when its usage limit resets.
 */
export const AtCapacity = Schema.TaggedStruct("AtCapacity", {
  message: Schema.NonEmptyString,
  resetsAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});

/** Fails the Attempt because admission refused a child over the budget. */
const OverBudget = Schema.TaggedStruct("OverBudget", { attempted: ChildSessionCount });

/**
 * A model handler's answer to one event. `clamp` checks it against the event, so free text is
 * optional wherever the event supplies it.
 */
export const ModelDecision = Schema.Union([
  Complete,
  RetryChild,
  Blocked,
  Question,
  Failed,
  InfraFailed,
  AtCapacity,
]);
export type ModelDecision = typeof ModelDecision.Type;

/** A rule's answer to one event: a `ModelDecision`, or a start or budget refusal only a rule makes. */
export const Decision = Schema.Union([StartChild, ...ModelDecision.members, OverBudget]);
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

/** The decision came after the Attempt settled. */
const AttemptSettled = Schema.TaggedStruct("AttemptSettled", {});

/** A `Start` came after the first child started. */
const AlreadyStarted = Schema.TaggedStruct("AlreadyStarted", {});

/** A decision about child `answering` came before the first child started. */
const NotStarted = Schema.TaggedStruct("NotStarted", { answering: ChildSessionCount });

/** A decision about child `answering` came after child `latest` replaced it. */
const StaleChild = Schema.TaggedStruct("StaleChild", {
  answering: ChildSessionCount,
  latest: ChildSessionCount,
});

/** Why `apply` left the state unchanged. */
const IgnoredReason = Schema.Union([AttemptSettled, AlreadyStarted, NotStarted, StaleChild]);
type IgnoredReason = typeof IgnoredReason.Type;

/** `apply` ignored the decision; the coordinator logs `reason` at Info. */
const Ignored = Schema.TaggedStruct("Ignored", { reason: IgnoredReason });

/**
 * An effect that runs after its transition commits: start a child, finish the Attempt, or log why
 * the decision changed nothing.
 */
export const EffectIntent = Schema.Union([Delegate, Finish, Ignored]);
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

/** Whether the child-session budget has a slot for a child that replaces `child`. */
const hasReplacementSlot = (child: ChildSessionCount, context: AttemptContext): boolean =>
  child < context.maxChildren;

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
      hasReplacementSlot(child, context)
        ? RetryChild.make({})
        : InfraFailed.make({
            message: `Child ${child} was interrupted and couldn't resume, and the ${context.maxChildren}-child budget has no room for a replacement: ${reason}`,
          }),
    ChildAtCapacity: ({ message, resetsAt }): Decision =>
      AtCapacity.make(
        Option.match(resetsAt, {
          onNone: () => ({ message }),
          onSome: (value) => ({ message, resetsAt: value }),
        }),
      ),
    ChildFailed: ({ message }): Decision => InfraFailed.make({ message }),
    BudgetExceeded: ({ attempted }): Decision => OverBudget.make({ attempted }),
  });

/**
 * Whether `event`'s report hands CI off to usine. Its rule relays the report unchanged, because the
 * engine reads the handoff only from the Attempt's message.
 */
export const handsOffCi = (event: ChildReported): boolean =>
  event.report.trim().startsWith(AWAITING_CI_MARKER);

/**
 * Whether a model may answer `event`: only a report without a reserved marker or a CI handoff.
 * Every other event takes its rule, so typed facts win, a handoff reaches the engine unchanged, and
 * an interrupted child that left no report can't complete.
 */
export const modelEligible = (event: CoordinatorEvent): boolean =>
  event._tag === "ChildReported" && Option.isNone(event.reserved) && !handsOffCi(event);

const reportText = (event: ChildReported): string =>
  event.report.trim() === "" ? BLANK_REPORT_MESSAGE : event.report;

const defaultMessage = (event: ChildEvent): string => {
  if (event._tag === "ChildReported") return reportText(event);
  if (event._tag === "ChildInterrupted")
    return `Child ${event.child} was interrupted: ${event.reason}`;
  if (event._tag === "BudgetExceeded")
    return `Admission refused child ${event.child} over the child-session budget`;
  return event.message;
};

/** The replacement's context: a reported child's report, or the interruption's default. */
const defaultAssignment = (event: ChildEvent): string =>
  event._tag === "ChildReported"
    ? `${REPORTED_REPLACEMENT_ASSIGNMENT}\n\n${reportText(event).trim()}`
    : REPLACEMENT_ASSIGNMENT;

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
      hasReplacementSlot(event.child, context)
        ? Replace.make({
            replaces: event.child,
            assignment: assignment ?? defaultAssignment(event),
          })
        : fail(
            AgentFailure.make({
              message: `Child ${event.child} needed a replacement, but the Attempt has used its ${context.maxChildren}-child budget`,
            }),
          ),
    Complete: ({ message }): ClampedDecision =>
      message === undefined && event._tag !== "ChildReported"
        ? // Only a report supplies a success message; no rule for another event completes.
          byRule()
        : settle(
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
    AtCapacity: ({ message, resetsAt }) =>
      fail(ProviderCapacityFailure.make({ message, resetsAt: Option.fromUndefinedOr(resetsAt) })),
  });
};

/**
 * Checks `decision` against `context.event`. A reserved marker, a CI handoff, and the other typed
 * facts keep their rule over any decision, a rule-only tag about a child takes the event's rule, and a replacement
 * past the child-session budget becomes `Failed`.
 */
export const clamp = (decision: Decision, context: AttemptContext): ClampedDecision => {
  const { event } = context;
  if (event._tag === "AttemptStarted") return Start.make({});
  return resolve(modelEligible(event) ? decision : ruleFor(event, context), event, context);
};

/**
 * Returns why `clamp` would replace a model's `decision` about `context.event` instead of applying
 * it as given, or `None` if it applies it: the event takes its rule, or a replacement has no room
 * in the child-session budget.
 */
export const clampRejection = (
  decision: ModelDecision,
  context: AttemptContext,
): Option.Option<string> => {
  const { event } = context;
  if (event._tag !== "ChildReported") return Option.some(`${event._tag} takes its rule`);
  if (Option.isSome(event.reserved))
    return Option.some("A report with a reserved marker takes its rule");
  if (handsOffCi(event)) return Option.some("A report with a CI handoff takes its rule");
  if (decision._tag === "RetryChild" && !hasReplacementSlot(event.child, context))
    return Option.some(
      `Child ${event.child} can't be replaced: the Attempt has used its ${context.maxChildren}-child budget`,
    );
  return Option.none();
};

type Transition = readonly [CoordinatorState, ReadonlyArray<EffectIntent>];

const ignore = (state: CoordinatorState, reason: IgnoredReason): Transition => [
  state,
  [Ignored.make({ reason })],
];

/**
 * Returns the next state and the effect intents for `decision`. A decision about a child other
 * than the latest one, a repeated start, and anything after the Attempt settled leave the state
 * unchanged and return one `Ignored` intent, so each interruption gets at most one replacement.
 */
export const apply = (state: CoordinatorState, decision: ClampedDecision): Transition => {
  if (state._tag === "Settled") return ignore(state, AttemptSettled.make({}));
  if (decision._tag === "Start") {
    if (state._tag !== "AwaitingStart") return ignore(state, AlreadyStarted.make({}));
    const child = ChildSessionCount.make(1);
    return [Delegating.make({ child }), [Delegate.make({ child, assignment: FIRST_ASSIGNMENT })]];
  }
  const answering = decision._tag === "Replace" ? decision.replaces : decision.answering;
  if (state._tag === "AwaitingStart") return ignore(state, NotStarted.make({ answering }));
  if (state.child !== answering)
    return ignore(state, StaleChild.make({ answering, latest: state.child }));
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
