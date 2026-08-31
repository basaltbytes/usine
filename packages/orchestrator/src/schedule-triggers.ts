import {
  environmentFor,
  type LoadedInstance,
  type LoopFile,
  type ManagedRepo,
  matchesSelector,
  type ScheduleTrigger,
} from "@usine/config";
import { Event, Item, Loop, Repository } from "@usine/core";
import { RunEngine, type RunEngineError, SubmissionResult } from "@usine/engine";
import { ExpressionEngine, type ExpressionError } from "@usine/expression";
import {
  Clock,
  Context,
  Cron,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { repositoryContext, submissionRunId, triggerSubmission } from "./trigger-submission.ts";

const FANOUT_CONCURRENCY = 4;

interface WatchedSchedule {
  readonly cron: Cron.Cron;
  readonly loop: LoopFile;
  readonly repositories: ReadonlyArray<ManagedRepo>;
  readonly trigger: ScheduleTrigger;
}

interface DueTick {
  readonly loop: LoopFile;
  readonly repository: ManagedRepo;
  readonly scheduledAt: DateTime.Utc;
  readonly trigger: ScheduleTrigger;
}

type ScheduleTriggerError = ExpressionError | RunEngineError;

/** One selected repository whose scheduled Tick could not be evaluated or submitted. */
export class ScheduleTickFailure extends Schema.Class<ScheduleTickFailure>(
  "@usine/orchestrator/ScheduleTickFailure",
)({
  loop: Loop.LoopName,
  repository: Repository.Name,
  scheduledAt: Schema.DateTimeUtc,
  errorTag: Schema.NonEmptyString,
  message: Schema.String,
}) {}

/** Observable result of evaluating every schedule loop at one clock instant. */
export class ScheduleCycle extends Schema.Class<ScheduleCycle>("@usine/orchestrator/ScheduleCycle")(
  {
    loops: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    fanout: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    submissions: Schema.Array(SubmissionResult),
    skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    failures: Schema.Array(ScheduleTickFailure),
    nextTickAt: Schema.Option(Schema.DateTimeUtc),
  },
) {}

const watchedSchedules = (instance: LoadedInstance): ReadonlyArray<WatchedSchedule> =>
  instance.loops.flatMap((loop) => {
    const trigger = loop.trigger;
    if (trigger.on !== "schedule") return [];
    const repositories = instance.config.repos.filter((repository) =>
      matchesSelector(loop.selector, repository),
    );
    return [
      {
        cron: Cron.parseUnsafe(trigger.cron, trigger.tz),
        loop,
        repositories,
        trigger,
      },
    ];
  });

/** Inclusive latest occurrence: Cron.prev itself is strict at an exact match. */
const latestScheduledAt = (cron: Cron.Cron, now: DateTime.Utc): DateTime.Utc => {
  const minuteBoundary = DateTime.toDateUtc(now);
  minuteBoundary.setUTCSeconds(0, 0);
  return DateTime.fromDateUnsafe(
    Cron.match(cron, minuteBoundary) ? minuteBoundary : Cron.prev(cron, minuteBoundary),
  );
};

const nextScheduledAt = (cron: Cron.Cron, now: DateTime.Utc): DateTime.Utc =>
  DateTime.fromDateUnsafe(Cron.next(cron, DateTime.toDateUtc(now)));

const earliest = (values: ReadonlyArray<DateTime.Utc>): Option.Option<DateTime.Utc> => {
  if (values.length === 0) return Option.none();
  return DateTime.make(Math.min(...values.map(DateTime.toEpochMillis)));
};

const itemKey = (repository: ManagedRepo): Item.ItemKey =>
  Item.ItemKey.make(JSON.stringify(["github", Repository.canonical(repository.name)]));

const eventKey = (
  loop: LoopFile,
  repository: ManagedRepo,
  scheduledAt: DateTime.Utc,
): Event.DedupKey =>
  Event.DedupKey.make(
    JSON.stringify([
      loop.name,
      Repository.canonical(repository.name),
      DateTime.formatIso(scheduledAt),
    ]),
  );

const tickPayload = (trigger: ScheduleTrigger, scheduledAt: DateTime.Utc): Schema.JsonObject => ({
  tick: {
    scheduledAt: DateTime.formatIso(scheduledAt),
    cron: trigger.cron,
    tz: trigger.tz,
  },
});

/** Clock-driven schedule → per-repository Event composition. */
export class ScheduleTriggers extends Context.Service<
  ScheduleTriggers,
  {
    /**
     * Evaluate only the latest due Tick for every schedule. Per-repository
     * failures are isolated, logged, and reported without stopping siblings.
     */
    readonly tick: (instance: LoadedInstance) => Effect.Effect<ScheduleCycle>;
    readonly run: (instance: LoadedInstance) => Effect.Effect<never>;
  }
>()("@usine/orchestrator/ScheduleTriggers") {
  static readonly layer = Layer.effect(
    ScheduleTriggers,
    Effect.gen(function* () {
      const expressions = yield* ExpressionEngine;
      const runs = yield* RunEngine;

      const submitTick = Effect.fn("ScheduleTriggers.submitTick")(function* (
        due: DueTick,
        receivedAt: DateTime.Utc,
      ) {
        yield* Effect.annotateCurrentSpan({
          loop: due.loop.name,
          repository: due.repository.name,
          scheduledAt: DateTime.formatIso(due.scheduledAt),
        });
        const payload = tickPayload(due.trigger, due.scheduledAt);
        const matches = yield* expressions.evaluateBoolean(
          due.trigger.if,
          environmentFor("schedule"),
          { repo: repositoryContext(due.repository), item: payload },
        );
        if (!matches) {
          yield* Effect.logDebug("Scheduled Tick did not match its expression", {
            loop: due.loop.name,
            repository: due.repository.name,
            scheduledAt: DateTime.formatIso(due.scheduledAt),
          });
          return Option.none<SubmissionResult>();
        }

        const dedupKey = eventKey(due.loop, due.repository, due.scheduledAt);
        const submitted = yield* runs.submit(
          triggerSubmission({
            dedupKey,
            itemKey: itemKey(due.repository),
            loop: due.loop,
            payload,
            receivedAt,
            repository: due.repository,
          }),
        );
        yield* Effect.logInfo("Submitted scheduled Tick", {
          loop: due.loop.name,
          repository: due.repository.name,
          scheduledAt: DateTime.formatIso(due.scheduledAt),
          result: submitted._tag,
          runId: submissionRunId(submitted),
        });
        return Option.some(submitted);
      });

      const tick = Effect.fn("ScheduleTriggers.tick")(function* (instance: LoadedInstance) {
        const now = yield* DateTime.now;
        const schedules = watchedSchedules(instance);
        for (const schedule of schedules) {
          if (schedule.repositories.length === 0) {
            yield* Effect.logDebug("Schedule loop selected no repositories", {
              loop: schedule.loop.name,
            });
          }
        }
        const due = schedules.flatMap((schedule) => {
          const scheduledAt = latestScheduledAt(schedule.cron, now);
          return schedule.repositories.map((repository): DueTick => ({
            loop: schedule.loop,
            repository,
            scheduledAt,
            trigger: schedule.trigger,
          }));
        });
        const settled = yield* Effect.forEach(
          due,
          (candidate) =>
            Effect.result(submitTick(candidate, now)).pipe(
              Effect.map((result) => ({ candidate, result })),
            ),
          { concurrency: FANOUT_CONCURRENCY },
        );

        const submissions: Array<SubmissionResult> = [];
        const failures: Array<ScheduleTickFailure> = [];
        let skipped = 0;
        for (const { candidate, result } of settled) {
          if (Result.isSuccess(result)) {
            if (Option.isSome(result.success)) submissions.push(result.success.value);
            else skipped += 1;
            continue;
          }
          const error: ScheduleTriggerError = result.failure;
          yield* Effect.logError("Scheduled Tick failed; sibling fanout was unaffected", {
            loop: candidate.loop.name,
            repository: candidate.repository.name,
            scheduledAt: DateTime.formatIso(candidate.scheduledAt),
            errorTag: error._tag,
            message: error.message,
          });
          failures.push(
            new ScheduleTickFailure({
              loop: candidate.loop.name,
              repository: candidate.repository.name,
              scheduledAt: candidate.scheduledAt,
              errorTag: error._tag,
              message: error.message,
            }),
          );
        }

        return new ScheduleCycle({
          loops: schedules.length,
          fanout: due.length,
          submissions,
          skipped,
          failures,
          nextTickAt: earliest(schedules.map(({ cron }) => nextScheduledAt(cron, now))),
        });
      });

      // No Effect.fn here: `run` never returns, so a named wrapper would open
      // a span that never closes. Each cycle's span lives on `tick`.
      const run = (instance: LoadedInstance): Effect.Effect<never> =>
        Effect.gen(function* () {
          const cycle = yield* tick(instance);
          const now = yield* Clock.currentTimeMillis;
          const target = Option.match(cycle.nextTickAt, {
            onNone: () => now + 60_000,
            onSome: DateTime.toEpochMillis,
          });
          const sleepMs = Math.max(0, target - now);
          yield* Effect.logInfo("Schedule cycle complete", {
            loops: cycle.loops,
            fanout: cycle.fanout,
            submissions: cycle.submissions.length,
            skipped: cycle.skipped,
            failures: cycle.failures.length,
            nextTickAt: Option.match(cycle.nextTickAt, {
              onNone: () => "none",
              onSome: DateTime.formatIso,
            }),
            sleepMs,
          });
          yield* Effect.sleep(Duration.millis(sleepMs));
        }).pipe(Effect.forever);

      return { run, tick };
    }),
  );
}
