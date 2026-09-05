import { Source } from "@usine/expression/model";
import { Cron as EffectCron, DateTime, Effect, Option, Result, Schema } from "effect";

// Uses the same Cron parser the scheduler evaluates with, so a cron that parses
// here parses at tick time too. Cron.prev and Cron.next can still fail inside a
// DST gap; the scheduler isolates that per schedule.
const isFiveFieldCron = (value: string): boolean =>
  value.trim().split(/\s+/u).length === 5 && Result.isSuccess(EffectCron.parse(value));

/** A five-field schedule evaluated in the trigger's time zone. */
export const Cron = Schema.String.check(
  Schema.makeFilter(isFiveFieldCron, { message: "Expected a valid five-field cron expression" }),
).pipe(Schema.brand("Cron"));

export type Cron = typeof Cron.Type;

const isTimeZone = (value: string): boolean => Option.isSome(DateTime.zoneMakeNamed(value));

/** The IANA time zone whose local clock defines a schedule's firing times. */
export const TimeZone = Schema.String.check(
  Schema.makeFilter(isTimeZone, { message: "Expected an IANA time-zone name" }),
).pipe(Schema.brand("TimeZone"));

export type TimeZone = typeof TimeZone.Type;

/** Watches issues and selects matching payloads with the Loop's `if` expression. */
export class IssueTrigger extends Schema.Class<IssueTrigger>("@usine/config/IssueTrigger")({
  on: Schema.Literal("issue"),
  if: Source,
}) {}

/** Watches pull requests and selects matching payloads with the Loop's `if` expression. */
export class PullRequestTrigger extends Schema.Class<PullRequestTrigger>(
  "@usine/config/PullRequestTrigger",
)({
  on: Schema.Literal("pr"),
  if: Source,
}) {}

/** Fires per selected repository on a schedule, catching up only the latest missed Tick after downtime. */
export class ScheduleTrigger extends Schema.Class<ScheduleTrigger>("@usine/config/ScheduleTrigger")(
  {
    on: Schema.Literal("schedule"),
    if: Source,
    cron: Cron,
    tz: TimeZone.pipe(Schema.withDecodingDefaultKey(Effect.succeed("UTC"))),
  },
) {}

/** The standing Item condition or schedule that produces Events for a Loop. */
export const Trigger = Schema.Union([IssueTrigger, PullRequestTrigger, ScheduleTrigger]);

export type Trigger = typeof Trigger.Type;

/** The class of state a Loop watches: issues, pull requests, or scheduled Ticks. */
export type Stream = Trigger["on"];
