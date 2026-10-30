import { Source } from "@usine/expression/expression-engine";
import { Cron as EffectCron, DateTime, Effect, Option, Result, Schema } from "effect";

// Uses the scheduler's Cron parser. `Cron.prev` and `Cron.next` can still fail in a DST gap; the
// scheduler handles that per schedule.
const isFiveFieldCron = (value: string): boolean =>
  value.trim().split(/\s+/u).length === 5 && Result.isSuccess(EffectCron.parse(value));

/** A five-field cron expression, evaluated in the trigger's time zone. */
export const Cron = Schema.String.check(
  Schema.makeFilter(isFiveFieldCron, { message: "Expected a valid five-field cron expression" }),
).pipe(Schema.brand("Cron"));

export type Cron = typeof Cron.Type;

const isTimeZone = (value: string): boolean => Option.isSome(DateTime.zoneMakeNamed(value));

/** An IANA time-zone name used to interpret schedule ticks. */
export const TimeZone = Schema.String.check(
  Schema.makeFilter(isTimeZone, { message: "Expected an IANA time-zone name" }),
).pipe(Schema.brand("TimeZone"));

export type TimeZone = typeof TimeZone.Type;

/** A trigger that selects issues matching the loop's `if` expression. */
export class IssueTrigger extends Schema.Class<IssueTrigger>("@usine/config/IssueTrigger")({
  /** The issue stream used to select the payload slice. */
  on: Schema.Literal("issue"),
  /** The CEL boolean condition evaluated against `item` and `repo`. */
  if: Source,
}) {}

/** A trigger that selects pull requests matching the loop's `if` expression. */
export class PullRequestTrigger extends Schema.Class<PullRequestTrigger>(
  "@usine/config/PullRequestTrigger",
)({
  /** The pull request stream used to select the payload slice. */
  on: Schema.Literal("pr"),
  /** The CEL boolean condition evaluated against `item` and `repo`. */
  if: Source,
}) {}

/**
 * A trigger that produces one event per selected repository at each cron time. After downtime,
 * produces only the latest missed tick.
 */
export class ScheduleTrigger extends Schema.Class<ScheduleTrigger>("@usine/config/ScheduleTrigger")(
  {
    /** The schedule stream used to select the payload slice. */
    on: Schema.Literal("schedule"),
    /** The CEL boolean condition evaluated against `item` and `repo`. */
    if: Source,
    /** The five-field cron expression that determines scheduled ticks. */
    cron: Cron,
    /** The time zone for the cron expression; decoding defaults to `UTC`. */
    tz: TimeZone.pipe(Schema.withDecodingDefaultKey(Effect.succeed("UTC"))),
  },
) {}

/** An issue, pull request, or schedule condition that can start a loop. */
export const Trigger = Schema.Union([IssueTrigger, PullRequestTrigger, ScheduleTrigger]);

export type Trigger = typeof Trigger.Type;

/** The kind of payload a trigger evaluates: issue, pull request, or schedule. */
export const Stream = Schema.Literals(["issue", "pr", "schedule"]);
export type Stream = typeof Stream.Type;
