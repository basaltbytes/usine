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

export const TimeZone = Schema.String.check(
  Schema.makeFilter(isTimeZone, { message: "Expected an IANA time-zone name" }),
).pipe(Schema.brand("TimeZone"));

export type TimeZone = typeof TimeZone.Type;

/** A trigger that selects issues matching the Loop's `if` expression. */
export class IssueTrigger extends Schema.Class<IssueTrigger>("@usine/config/IssueTrigger")({
  on: Schema.Literal("issue"),
  if: Source,
}) {}

/** A trigger that selects pull requests matching the Loop's `if` expression. */
export class PullRequestTrigger extends Schema.Class<PullRequestTrigger>(
  "@usine/config/PullRequestTrigger",
)({
  on: Schema.Literal("pr"),
  if: Source,
}) {}

/** A trigger that produces one Event per selected repository at each cron time. After downtime, produces only the latest missed Tick. */
export class ScheduleTrigger extends Schema.Class<ScheduleTrigger>("@usine/config/ScheduleTrigger")(
  {
    on: Schema.Literal("schedule"),
    if: Source,
    cron: Cron,
    tz: TimeZone.pipe(Schema.withDecodingDefaultKey(Effect.succeed("UTC"))),
  },
) {}

export const Trigger = Schema.Union([IssueTrigger, PullRequestTrigger, ScheduleTrigger]);

export type Trigger = typeof Trigger.Type;

export type Stream = Trigger["on"];
