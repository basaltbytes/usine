import { Effect, Match, Option, Schema } from "effect";

import {
  AttemptContext,
  CoordinatorEvent,
  type DelegationEnd,
  DelegationSummary,
} from "../attempt/coordinator/rules.ts";
import type { CoordinatorSnapshot, DelegationRecord } from "./journal.ts";

/** The most characters of encoded JSON that a context takes, about 4,000 tokens. */
export const CONTEXT_CHARACTERS = 16_000;
const TASK_CHARACTERS = 4_000;
const REPORT_CHARACTERS = 4_000;
const OUTPUT_CHARACTERS = 2_000;
const LINE_CHARACTERS = 160;

const decodeEvent = Schema.decodeUnknownEffect(Schema.toCodecJson(CoordinatorEvent));
/** Encodes a context as the JSON text that a model reads. */
export const encodeAttemptContext = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(AttemptContext)),
);

const line = (text: string) => {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > LINE_CHARACTERS ? `${collapsed.slice(0, LINE_CHARACTERS)}…` : collapsed;
};

const endOf = (event: CoordinatorEvent): Option.Option<readonly [DelegationEnd, string]> =>
  Match.valueTags(event, {
    AttemptStarted: () => Option.none(),
    ChildReported: ({ report, reserved }) =>
      Option.some([
        Option.match(reserved, { onNone: () => "reported" as const, onSome: ({ kind }) => kind }),
        report,
      ] as const),
    ChildInterrupted: ({ reason }) => Option.some(["interrupted", reason] as const),
    ChildAtCapacity: ({ message }) => Option.some(["capacity", message] as const),
    ChildFailed: ({ message }) => Option.some(["infrastructure", message] as const),
    BudgetExceeded: ({ attempted }) =>
      Option.some(["over-budget", `Admission refused child ${attempted}`] as const),
  });

/** The child that `event` is about, or `None` for the Attempt's start. */
const childOf = (event: CoordinatorEvent) =>
  event._tag === "AttemptStarted" ? Option.none() : Option.some(event.child);

const summaries = Effect.fn("AttemptContext.delegations")(function* (
  delegations: ReadonlyArray<DelegationRecord>,
  event: CoordinatorEvent,
) {
  const ended = yield* Effect.forEach(delegations, (record) =>
    Option.match(record.outcome, {
      onNone: () =>
        Effect.succeed({ record, end: Option.none<readonly [DelegationEnd, string]>() }),
      // The coordinator encoded every outcome it recorded.
      onSome: (outcome) =>
        decodeEvent(outcome).pipe(
          Effect.orDie,
          Effect.map((decoded) => ({ record, end: endOf(decoded) })),
        ),
    }),
  );
  const handled = childOf(event);
  // The event carries its child's report, so it counts as one of the two full reports.
  const full = new Set(
    ended
      .filter(({ record, end }) => Option.isSome(end) && !Option.contains(handled, record.number))
      .map(({ record }) => record.number)
      .slice(Option.isSome(handled) ? -1 : -2),
  );
  return ended.map(({ record, end }) =>
    DelegationSummary.make({
      child: record.number,
      status: Option.isSome(record.outcome)
        ? "ended"
        : Option.isSome(record.progress)
          ? "running"
          : "intended",
      end: Option.map(end, ([kind]) => kind),
      report: Option.contains(handled, record.number)
        ? Option.none()
        : Option.map(end, ([, text]) =>
            full.has(record.number) ? text.slice(0, REPORT_CHARACTERS) : line(text),
          ),
    }),
  );
});

const characters = (context: AttemptContext) =>
  encodeAttemptContext(context).pipe(
    // Every field was validated at construction.
    Effect.orDie,
    Effect.map((encoded) => encoded.length),
  );

/** Each shortens one field by about `excess` characters, in the order `fitted` applies them. */
const shortenings: ReadonlyArray<(context: AttemptContext, excess: number) => AttemptContext> = [
  (context, excess) =>
    AttemptContext.make({
      ...context,
      task: context.task.slice(0, Math.max(0, context.task.length - excess)),
    }),
  (context, excess) => AttemptContext.make({ ...context, output: context.output.slice(excess) }),
  (context, excess) =>
    AttemptContext.make({
      ...context,
      delegations: context.delegations.map((summary) =>
        DelegationSummary.make({
          ...summary,
          report: Option.map(summary.report, (report) =>
            report.slice(0, Math.max(LINE_CHARACTERS, report.length - excess)),
          ),
        }),
      ),
    }),
];

/** Shortens the task, then the output, then the reports, until the context fits the cap. */
const fitted = Effect.fn("AttemptContext.fit")(function* (context: AttemptContext) {
  let current = context;
  for (const shorten of shortenings) {
    const excess = (yield* characters(current)) - CONTEXT_CHARACTERS;
    if (excess <= 0) return current;
    current = shorten(current, excess);
  }
  const excess = (yield* characters(current)) - CONTEXT_CHARACTERS;
  if (excess > 0)
    yield* Effect.logWarning(
      "The event alone exceeds the context cap; the context keeps it whole",
      {
        event: current.event._tag,
        excess,
      },
    );
  return current;
});

/**
 * Returns what a handler knows about `event`, read from the journal alone: the event whole, the
 * first 4,000 characters of the rendered task, the outcome labels and CI policy, each delegation
 * with the latest two reports up to 4,000 characters and earlier ones as one line, and the last
 * 2,000 characters of the latest child's output. Shortens the task, output, and reports so the
 * encoded context stays within `CONTEXT_CHARACTERS` unless the event alone is longer.
 */
export const buildAttemptContext = Effect.fn("AttemptContext.build")(function* (
  snapshot: CoordinatorSnapshot,
  event: CoordinatorEvent,
) {
  const spec = snapshot.request.spec;
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, event: event._tag });
  const latest = Option.fromUndefinedOr(snapshot.delegations.at(-1));
  const output = Option.getOrElse(
    Option.flatMap(latest, ({ progress }) => Option.map(progress, ({ output }) => output)),
    () => "",
  );
  const delegations = yield* summaries(snapshot.delegations, event);
  const context = yield* fitted(
    AttemptContext.make({
      event,
      maxChildren: spec.maxChildren,
      repository: spec.repository,
      agent: spec.agent.name,
      task: spec.task.slice(0, TASK_CHARACTERS),
      outcomeLabels: spec.outcomeLabels,
      requiresCi: spec.requiresCi,
      delegations,
      output: output.slice(-OUTPUT_CHARACTERS),
    }),
  );
  const size = yield* characters(context);
  yield* Effect.logDebug("Built the coordinator's context for the event", {
    attemptId: spec.attemptId,
    event: event._tag,
    characters: size,
  });
  return context;
});
