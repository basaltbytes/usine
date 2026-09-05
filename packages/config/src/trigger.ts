import { Source } from "@usine/expression/model";
import { Cron as EffectCron, DateTime, Effect, Option, Result, Schema } from "effect";

// Validated by the same effect Cron parser the engine's scheduler evaluates
// with, so a cron that parses here parses at tick time too. Evaluation is a
// weaker guarantee: Cron.prev/next can still fail inside a DST gap, which the
// scheduler isolates per schedule.
const isFiveFieldCron = (value: string): boolean =>
  value.trim().split(/\s+/u).length === 5 && Result.isSuccess(EffectCron.parse(value));

export const Cron = Schema.String.check(
  Schema.makeFilter(isFiveFieldCron, { message: "Expected a valid five-field cron expression" }),
).pipe(Schema.brand("Cron"));

export type Cron = typeof Cron.Type;

const isTimeZone = (value: string): boolean => Option.isSome(DateTime.zoneMakeNamed(value));

export const TimeZone = Schema.String.check(
  Schema.makeFilter(isTimeZone, { message: "Expected an IANA time-zone name" }),
).pipe(Schema.brand("TimeZone"));

export type TimeZone = typeof TimeZone.Type;

export class IssueTrigger extends Schema.Class<IssueTrigger>("@usine/config/IssueTrigger")({
  on: Schema.Literal("issue"),
  if: Source,
}) {}

export class PullRequestTrigger extends Schema.Class<PullRequestTrigger>(
  "@usine/config/PullRequestTrigger",
)({
  on: Schema.Literal("pr"),
  if: Source,
}) {}

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

/** The watched streams, derived from the Trigger union so the set has one owner. */
export type Stream = Trigger["on"];
