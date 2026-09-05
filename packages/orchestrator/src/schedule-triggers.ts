import type { ConfigFileError } from "@usine/config/file";
import type { LoadedInstance } from "@usine/config/instance";
import type { LoopFile } from "@usine/config/loop";
import type { ManagedRepo } from "@usine/config/factory";
import type { ScheduleTrigger } from "@usine/config/trigger";
import { ConfigParser } from "@usine/config/parser";
import { environmentFor, repositoryContext } from "@usine/config/payload-slices";
import { matchesSelector } from "@usine/config/selector";
import { AttemptTask } from "@usine/core/attempt";
import { AgentName } from "@usine/core/agent";
import { DedupKey } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import {
  RunEngine,
  type EnginePersistenceError,
  type RunEngineError,
  SubmissionResult,
} from "@usine/engine/engine";
import { LoopControl } from "@usine/engine/loop-control";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import type { ExpressionError } from "@usine/expression/model";
import {
  Clock,
  Context,
  Cron,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from "effect";
import {
  configFileErrorLogFields,
  type LoopAgentResolutionError,
  type ResolvedLoop,
  resolveTriggerLoop,
  submissionLogFields,
  triggerSubmission,
} from "./trigger-submission.ts";

/** Fanout submits to local SQLite only — kept small so write transactions don't pile up. */
const FANOUT_CONCURRENCY = 4;
/** Wake cadence when no schedule can name its next boundary (none exist, or cron math is down). */
const IDLE_WAKE_MILLIS = 60_000;

interface WatchedSchedule {
  readonly loop: LoopFile;
  readonly repositories: ReadonlyArray<ManagedRepo>;
  readonly trigger: ScheduleTrigger;
}

interface ScheduleBoundaries {
  readonly latest: DateTime.Utc;
  readonly latestLocal: string;
  readonly next: DateTime.Utc;
}

interface DueTick extends ResolvedLoop {
  readonly repository: ManagedRepo;
  readonly scheduledAt: DateTime.Utc;
  readonly scheduledAtLocal: string;
  readonly trigger: ScheduleTrigger;
}

type ScheduleTriggerError = ConfigFileError | ExpressionError | RunEngineError;

const scheduleFailureLogFields = (error: ScheduleTriggerError) => {
  const common = { errorTag: error._tag, message: error.message };
  if (error._tag === "ConfigFileError") {
    return { ...common, ...configFileErrorLogFields(error) };
  }
  if (error._tag === "ExpressionCheckError" || error._tag === "ExpressionEvaluationError") {
    return { ...common, expression: error.source };
  }
  return common;
};

/** One schedule loop whose authored Agent disappeared from the loaded roster. */
export class ScheduleAgentFailure extends Schema.TaggedClass<ScheduleAgentFailure>(
  "@usine/orchestrator/ScheduleAgentFailure",
)("ScheduleAgentFailure", {
  loop: LoopName,
  agent: AgentName,
  message: Schema.String,
}) {}

/** One selected repository whose scheduled Tick could not be evaluated or submitted. */
export class ScheduleTickFailure extends Schema.TaggedClass<ScheduleTickFailure>(
  "@usine/orchestrator/ScheduleTickFailure",
)("ScheduleTickFailure", {
  loop: LoopName,
  repository: RepositoryName,
  scheduledAt: Schema.DateTimeUtc,
  errorTag: Schema.NonEmptyString,
  message: Schema.String,
}) {}

/**
 * One schedule whose cron boundaries could not be computed at this instant —
 * effect's Cron.prev/next can fail inside a DST spring-forward gap even for a
 * cron that parsed cleanly. The schedule retries next cycle; siblings run.
 */
export class ScheduleCronFailure extends Schema.TaggedClass<ScheduleCronFailure>(
  "@usine/orchestrator/ScheduleCronFailure",
)("ScheduleCronFailure", {
  loop: LoopName,
  cron: Schema.String,
  tz: Schema.String,
  message: Schema.String,
}) {}

export const ScheduleFailure = Schema.Union([
  ScheduleAgentFailure,
  ScheduleCronFailure,
  ScheduleTickFailure,
]);
export type ScheduleFailure = typeof ScheduleFailure.Type;

/** Observable result of evaluating every schedule loop at one clock instant. */
export class ScheduleCycle extends Schema.Class<ScheduleCycle>("@usine/orchestrator/ScheduleCycle")(
  {
    loops: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    fanout: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    submissions: Schema.Array(SubmissionResult),
    skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    alreadyFired: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    failures: Schema.Array(ScheduleFailure),
    nextTickAt: Schema.Option(Schema.DateTimeUtc),
  },
) {}

const watchedSchedules = (instance: LoadedInstance): ReadonlyArray<WatchedSchedule> =>
  instance.loops.flatMap((loop) => {
    const trigger = loop.trigger;
    if (trigger.on !== "schedule") return [];
    return [
      {
        loop,
        repositories: instance.config.repos.filter((repository) =>
          matchesSelector(loop.selector, repository),
        ),
        trigger,
      },
    ];
  });

/**
 * Inclusive latest occurrence: Cron.prev itself is strict at an exact match.
 * Across a DST fall-back the same local time maps to two UTC instants and both
 * are legal boundaries — the payload's zone-local time makes the pair
 * explicable in logs, and the permanent dedup ledger keeps each a single fact.
 */
const latestScheduledAt = (cron: Cron.Cron, now: DateTime.Utc): DateTime.Utc => {
  const minuteBoundary = DateTime.toDateUtc(now);
  minuteBoundary.setUTCSeconds(0, 0);
  return DateTime.fromDateUnsafe(
    Cron.match(cron, minuteBoundary) ? minuteBoundary : Cron.prev(cron, minuteBoundary),
  );
};

const nextScheduledAt = (cron: Cron.Cron, now: DateTime.Utc): DateTime.Utc =>
  DateTime.fromDateUnsafe(Cron.next(cron, DateTime.toDateUtc(now)));

const localTime = (scheduledAt: DateTime.Utc, tz: string): string =>
  Option.match(DateTime.setZoneNamed(scheduledAt, tz), {
    onNone: () => DateTime.formatIso(scheduledAt),
    onSome: DateTime.formatIsoZoned,
  });

const earliest = (values: ReadonlyArray<DateTime.Utc>): Option.Option<DateTime.Utc> => {
  if (values.length === 0) return Option.none();
  return DateTime.make(Math.min(...values.map(DateTime.toEpochMillis)));
};

const itemKey = (repository: ManagedRepo): ItemKey =>
  ItemKey.make(JSON.stringify(["github", canonicalRepositoryName(repository.name)]));

const eventKey = (loop: LoopFile, repository: ManagedRepo, scheduledAt: DateTime.Utc): DedupKey =>
  DedupKey.make(
    JSON.stringify([
      loop.name,
      canonicalRepositoryName(repository.name),
      DateTime.formatIso(scheduledAt),
    ]),
  );

const tickPayload = (due: DueTick): Schema.JsonObject => ({
  tick: {
    scheduledAt: DateTime.formatIso(due.scheduledAt),
    scheduledAtLocal: due.scheduledAtLocal,
    cron: due.trigger.cron,
    tz: due.trigger.tz,
  },
});

/** Clock-driven schedule → per-repository Event composition. */
export class ScheduleTriggers extends Context.Service<
  ScheduleTriggers,
  {
    /**
     * Evaluate only the latest due Tick for every schedule. Per-repository
     * failures are isolated, logged, and reported without stopping siblings;
     * cron-math failures (DST gaps) fail only their own schedule.
     */
    readonly tick: (
      instance: LoadedInstance,
    ) => Effect.Effect<ScheduleCycle, EnginePersistenceError>;
    readonly run: (instance: LoadedInstance) => Effect.Effect<never>;
    readonly latest: Effect.Effect<Option.Option<ScheduleCycle>>;
  }
>()("@usine/orchestrator/ScheduleTriggers") {
  static readonly layer = Layer.effect(
    ScheduleTriggers,
    Effect.gen(function* () {
      const config = yield* ConfigParser;
      const expressions = yield* ExpressionEngine;
      const runs = yield* RunEngine;
      const loops = yield* LoopControl;
      const latestCycle = yield* Ref.make(Option.none<ScheduleCycle>());
      // Efficiency-only fired-tick memory: an empty map after a restart is
      // exactly ADR 0007's "fire the latest missed tick"; the permanent dedup
      // ledger stays the correctness guarantee.
      const lastFired = yield* Ref.make(new Map<LoopName, number>());
      // Cron sources are immutable once parsed at the config boundary; parsing
      // again per cycle is waste. parseUnsafe trusts that boundary validation.
      const parsedCrons = new WeakMap<ScheduleTrigger, Cron.Cron>();
      const cronFor = (trigger: ScheduleTrigger): Cron.Cron => {
        const cached = parsedCrons.get(trigger);
        if (cached !== undefined) return cached;
        const parsed = Cron.parseUnsafe(trigger.cron, trigger.tz);
        parsedCrons.set(trigger, parsed);
        return parsed;
      };

      const submitTick = Effect.fn("ScheduleTriggers.submitTick")(function* (
        due: DueTick,
        receivedAt: DateTime.Utc,
      ) {
        yield* Effect.annotateCurrentSpan({
          loop: due.loop.name,
          repository: due.repository.name,
          agent: due.agent.name,
          scheduledAt: DateTime.formatIso(due.scheduledAt),
        });
        const payload = tickPayload(due);
        const context = { repo: repositoryContext(due.repository), item: payload };
        const matches = yield* expressions.evaluateBoolean(
          due.trigger.if,
          environmentFor("schedule"),
          context,
        );
        if (!matches) {
          yield* Effect.logDebug("Scheduled Tick did not match its expression", {
            loop: due.loop.name,
            repository: due.repository.name,
            agent: due.agent.name,
            scheduledAt: DateTime.formatIso(due.scheduledAt),
          });
          return Option.none<SubmissionResult>();
        }

        const dedupKey = eventKey(due.loop, due.repository, due.scheduledAt);
        const task = yield* config.renderPrompt(due.loop, context);
        const submitted = yield* runs.submit(
          triggerSubmission({
            agent: due.agent,
            dedupKey,
            itemKey: itemKey(due.repository),
            loop: due.loop,
            payload,
            receivedAt,
            repository: due.repository,
            task: AttemptTask.make(task),
            parentModel: due.parentModel,
          }),
        );
        yield* Effect.logInfo("Submitted scheduled Tick", {
          loop: due.loop.name,
          repository: due.repository.name,
          agent: due.agent.name,
          scheduledAt: DateTime.formatIso(due.scheduledAt),
          scheduledAtLocal: due.scheduledAtLocal,
          result: submitted._tag,
          ...submissionLogFields(submitted),
        });
        return Option.some(submitted);
      });

      const tick = Effect.fn("ScheduleTriggers.tick")(function* (instance: LoadedInstance) {
        const now = yield* DateTime.now;
        const paused = new Set(
          (yield* loops.states).filter((state) => state.paused).map((state) => state.loop),
        );
        for (const loop of instance.loops) {
          if (loop.trigger.on === "schedule" && paused.has(loop.name)) {
            yield* Effect.logDebug("Paused Loop skipped during schedule evaluation", {
              loop: loop.name,
            });
          }
        }
        const schedules = watchedSchedules(instance).filter(({ loop }) => !paused.has(loop.name));
        const fired = yield* Ref.get(lastFired);

        const due: Array<DueTick> = [];
        const agentFailures: Array<ScheduleAgentFailure> = [];
        const cronFailures: Array<ScheduleCronFailure> = [];
        const boundariesByLoop = new Map<LoopName, number>();
        const nexts: Array<DateTime.Utc> = [];
        let alreadyFired = 0;
        for (const schedule of schedules) {
          if (schedule.repositories.length === 0) {
            yield* Effect.logWarning("Schedule loop selected no repositories", {
              loop: schedule.loop.name,
            });
          }
          // Cron evaluation can throw inside a DST spring-forward gap even
          // though the expression parsed cleanly; one schedule's bad instant
          // must never take the stream down.
          const computed = yield* Effect.try({
            try: (): ScheduleBoundaries => {
              const cron = cronFor(schedule.trigger);
              const latest = latestScheduledAt(cron, now);
              return {
                latest,
                latestLocal: localTime(latest, schedule.trigger.tz),
                next: nextScheduledAt(cron, now),
              };
            },
            catch: (cause) => cause,
          }).pipe(Effect.result);
          if (Result.isFailure(computed)) {
            yield* Effect.logError("Schedule cron boundaries could not be computed", {
              loop: schedule.loop.name,
              cron: schedule.trigger.cron,
              tz: schedule.trigger.tz,
              message: String(computed.failure),
            });
            cronFailures.push(
              new ScheduleCronFailure({
                loop: schedule.loop.name,
                cron: schedule.trigger.cron,
                tz: schedule.trigger.tz,
                message: String(computed.failure),
              }),
            );
            continue;
          }
          const boundaries = computed.success;
          nexts.push(boundaries.next);
          const latestEpoch = DateTime.toEpochMillis(boundaries.latest);
          const last = fired.get(schedule.loop.name);
          if (last !== undefined && last >= latestEpoch) {
            alreadyFired += 1;
            yield* Effect.logDebug("Tick already fired", {
              loop: schedule.loop.name,
              scheduledAt: DateTime.formatIso(boundaries.latest),
            });
            continue;
          }
          const resolved = yield* Effect.result(resolveTriggerLoop(instance, schedule.loop));
          if (Result.isFailure(resolved)) {
            const error: LoopAgentResolutionError = resolved.failure;
            yield* Effect.logError("Schedule loop could not resolve its Agent", {
              loop: error.loop,
              agent: error.agent,
              errorTag: error._tag,
              message: error.message,
            });
            agentFailures.push(
              new ScheduleAgentFailure({
                loop: error.loop,
                agent: error.agent,
                message: error.message,
              }),
            );
            continue;
          }
          if (schedule.repositories.length === 0) continue;
          boundariesByLoop.set(schedule.loop.name, latestEpoch);
          yield* Effect.logInfo("Schedule tick due", {
            loop: schedule.loop.name,
            agent: resolved.success.agent.name,
            cron: schedule.trigger.cron,
            tz: schedule.trigger.tz,
            scheduledAt: DateTime.formatIso(boundaries.latest),
            scheduledAtLocal: boundaries.latestLocal,
            repositories: schedule.repositories.length,
            nextTickAt: DateTime.formatIso(boundaries.next),
          });
          for (const repository of schedule.repositories) {
            due.push({
              agent: resolved.success.agent,
              loop: schedule.loop,
              parentModel: resolved.success.parentModel,
              repository,
              scheduledAt: boundaries.latest,
              scheduledAtLocal: boundaries.latestLocal,
              trigger: schedule.trigger,
            });
          }
        }
        yield* Effect.annotateCurrentSpan({ schedules: schedules.length, fanout: due.length });

        const settled = yield* Effect.forEach(
          due,
          (candidate) =>
            Effect.result(submitTick(candidate, now)).pipe(
              Effect.map((result) => ({ candidate, result })),
            ),
          { concurrency: FANOUT_CONCURRENCY },
        );

        const submissions: Array<SubmissionResult> = [];
        const tickFailures: Array<ScheduleTickFailure> = [];
        const submittedLoops = new Set<LoopName>();
        const failedLoops = new Set<LoopName>();
        let skipped = 0;
        for (const { candidate, result } of settled) {
          if (Result.isSuccess(result)) {
            if (Option.isSome(result.success)) {
              submissions.push(result.success.value);
              submittedLoops.add(candidate.loop.name);
            } else skipped += 1;
            continue;
          }
          const error: ScheduleTriggerError = result.failure;
          failedLoops.add(candidate.loop.name);
          yield* Effect.logError("Scheduled Tick failed; sibling fanout was unaffected", {
            loop: candidate.loop.name,
            repository: candidate.repository.name,
            agent: candidate.agent.name,
            scheduledAt: DateTime.formatIso(candidate.scheduledAt),
            ...scheduleFailureLogFields(error),
          });
          tickFailures.push(
            new ScheduleTickFailure({
              loop: candidate.loop.name,
              repository: candidate.repository.name,
              scheduledAt: candidate.scheduledAt,
              errorTag: error._tag,
              message: error.message,
            }),
          );
        }

        // Advance the fired-tick memory only for loops that submitted without
        // a failure: an all-unmatched tick keeps re-evaluating (so a fixed
        // `if:` still fires it), a failed loop retries every repository next
        // cycle, and the dedup ledger absorbs the ones that already landed.
        yield* Ref.update(lastFired, (current) => {
          const next = new Map(current);
          for (const [loop, latestEpoch] of boundariesByLoop) {
            if (submittedLoops.has(loop) && !failedLoops.has(loop)) {
              next.set(loop, latestEpoch);
            }
          }
          return next;
        });

        const cycle = new ScheduleCycle({
          loops: schedules.length,
          fanout: due.length,
          submissions,
          skipped,
          alreadyFired,
          failures: [...agentFailures, ...cronFailures, ...tickFailures],
          nextTickAt: earliest(nexts),
        });
        yield* Ref.set(latestCycle, Option.some(cycle));
        return cycle;
      });

      // No Effect.fn here: `run` never returns, so a named wrapper would open
      // a span that never closes. Each cycle's span lives on `tick`.
      const run = (instance: LoadedInstance): Effect.Effect<never> =>
        Effect.gen(function* () {
          const result = yield* Effect.result(tick(instance));
          if (Result.isFailure(result)) {
            yield* Effect.logError("Schedule cycle could not read Loop runtime state; retrying", {
              errorTag: result.failure._tag,
              message: result.failure.message,
              operation: result.failure.operation,
              sleepMs: IDLE_WAKE_MILLIS,
            });
            yield* Effect.sleep(Duration.millis(IDLE_WAKE_MILLIS));
            return;
          }
          const cycle = result.success;
          const now = yield* Clock.currentTimeMillis;
          const target = Option.match(cycle.nextTickAt, {
            onNone: () => now + IDLE_WAKE_MILLIS,
            onSome: DateTime.toEpochMillis,
          });
          const sleepMs = Math.min(IDLE_WAKE_MILLIS, Math.max(0, target - now));
          const summary = {
            loops: cycle.loops,
            fanout: cycle.fanout,
            submissions: cycle.submissions.length,
            skipped: cycle.skipped,
            alreadyFired: cycle.alreadyFired,
            failures: cycle.failures.length,
            nextTickAt: Option.match(cycle.nextTickAt, {
              onNone: () => "none",
              onSome: DateTime.formatIso,
            }),
            sleepMs,
          };
          // An instance with nothing due should not emit a minutely INFO line
          // forever; anything that acted or failed stays visible.
          if (cycle.fanout === 0 && cycle.failures.length === 0) {
            yield* Effect.logDebug("Schedule cycle complete", summary);
          } else {
            yield* Effect.logInfo("Schedule cycle complete", summary);
          }
          yield* Effect.sleep(Duration.millis(sleepMs));
        }).pipe(Effect.forever);

      return { latest: Ref.get(latestCycle), run, tick };
    }),
  );
}
