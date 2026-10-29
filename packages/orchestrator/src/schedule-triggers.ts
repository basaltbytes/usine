import { CycleGeneration } from "@usine/core/cycle-budget";
import type { ConfigFileError } from "@usine/config/file";
import type { LoadedInstance } from "@usine/config/instance";
import type { LoopFile } from "@usine/config/loop";
import type { ManagedRepo } from "@usine/config/factory";
import type { ScheduleTrigger } from "@usine/config/trigger";
import { ConfigParser } from "@usine/config/parser";
import { environmentFor, repositoryContext } from "@usine/config/payload-slices";
import { matchesLoop } from "@usine/config/project";
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
import { ExpressionEngine, type ExpressionError } from "@usine/expression/expression-engine";
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
import { reloadedFrom, type WatchedInstance } from "./reloads.ts";
import {
  configFileErrorLogFields,
  DEFAULT_BRANCH_REVISION,
  type LoopAgentResolutionError,
  type ResolvedLoop,
  resolveTriggerLoop,
  submissionLogFields,
  triggerSubmission,
} from "./trigger-submission.ts";

/** The maximum concurrent submissions, kept small to avoid piling up SQLite write transactions. */
const FANOUT_CONCURRENCY = 4;
/** The wake interval when no schedule has a next boundary. */
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

/** A schedule Loop whose Agent is no longer in the loaded roster. */
export class ScheduleAgentFailure extends Schema.TaggedClass<ScheduleAgentFailure>(
  "@usine/orchestrator/ScheduleAgentFailure",
)("ScheduleAgentFailure", {
  loop: LoopName,
  agent: AgentName,
  message: Schema.String,
}) {}

/** A selected repository whose Tick couldn't be evaluated or submitted. */
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
 * A schedule whose cron boundaries couldn't be computed at this instant. `Cron.prev` and
 * `Cron.next` fail inside a DST spring-forward gap; the schedule retries next cycle.
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

/** The result of evaluating every schedule loop at one instant. */
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
          matchesLoop(instance.config, loop, repository),
        ),
        trigger,
      },
    ];
  });

/**
 * Returns the latest occurrence at or before `now`, since `Cron.prev` alone excludes an exact
 * match. Across a DST fall-back, both UTC instants of the repeated local time are boundaries.
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

/** Turns due schedule ticks into one Event per selected repository. */
export class ScheduleTriggers extends Context.Service<
  ScheduleTriggers,
  {
    /**
     * Evaluates the latest due Tick of every schedule. Reports a repository or cron failure without
     * stopping the other schedules, and forgets fired Ticks when the instance differs from the
     * previous tick's.
     */
    readonly tick: (
      instance: LoadedInstance,
    ) => Effect.Effect<ScheduleCycle, EnginePersistenceError>;
    /**
     * Runs ticks until interrupted, sleeping until the earliest next Tick for at most a minute. An
     * accepted reload ends the sleep so the next tick evaluates the reloaded Loops.
     */
    readonly run: (instances: WatchedInstance) => Effect.Effect<never>;
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
      // Remembers fired Ticks to skip repeat work. After a restart or reload, the empty map fires
      // the latest missed Tick (ADR 0007); the dedup ledger guarantees correctness.
      const lastFired = yield* Ref.make({
        instance: Option.none<LoadedInstance>(),
        ticks: new Map<LoopName, number>(),
      });
      // Cron sources were validated at the config boundary, so `parseUnsafe` is safe; results are
      // cached per trigger.
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
            cycleGeneration: CycleGeneration.make(0),
            agent: due.agent,
            dedupKey,
            itemKey: itemKey(due.repository),
            loop: due.loop,
            payload,
            receivedAt,
            repository: due.repository,
            revision: DEFAULT_BRANCH_REVISION,
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
        const fired = yield* Ref.modify(lastFired, (memory) => {
          const current = Option.contains(memory.instance, instance)
            ? memory
            : { instance: Option.some(instance), ticks: new Map<LoopName, number>() };
          return [current.ticks, current] as const;
        });

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
          // Cron evaluation throws inside a DST spring-forward gap even for a valid expression, and
          // one schedule's bad instant must not stop the others.
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

        // Only Loops that submitted without a failure advance the fired-Tick memory, so unmatched
        // Ticks and failed Loops are retried next cycle. The dedup ledger absorbs duplicate
        // submissions.
        yield* Ref.update(lastFired, (memory) => {
          const next = new Map(memory.ticks);
          for (const [loop, latestEpoch] of boundariesByLoop) {
            if (submittedLoops.has(loop) && !failedLoops.has(loop)) {
              next.set(loop, latestEpoch);
            }
          }
          return { ...memory, ticks: next };
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

      const waitForNextTick = (
        instances: WatchedInstance,
        evaluated: LoadedInstance,
        sleepMs: number,
      ): Effect.Effect<void> =>
        Effect.raceFirst(
          Effect.sleep(Duration.millis(sleepMs)),
          reloadedFrom(instances, evaluated).pipe(
            Effect.andThen(
              Effect.logInfo(
                "Instance reloaded; evaluating schedules now instead of after the sleep",
              ),
            ),
          ),
        );

      // `run` never returns, so wrapping it in Effect.fn would open a span that
      // never closes; `tick` opens the span for each cycle.
      const run = (instances: WatchedInstance): Effect.Effect<never> =>
        Effect.gen(function* () {
          const instance = yield* instances.get;
          const result = yield* Effect.result(tick(instance));
          if (Result.isFailure(result)) {
            yield* Effect.logError("Schedule cycle could not read Loop runtime state; retrying", {
              errorTag: result.failure._tag,
              message: result.failure.message,
              operation: result.failure.operation,
              sleepMs: IDLE_WAKE_MILLIS,
            });
            yield* waitForNextTick(instances, instance, IDLE_WAKE_MILLIS);
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
          // Quiet cycles log at Debug; cycles that acted or failed log at Info.
          if (cycle.fanout === 0 && cycle.failures.length === 0) {
            yield* Effect.logDebug("Schedule cycle complete", summary);
          } else {
            yield* Effect.logInfo("Schedule cycle complete", summary);
          }
          yield* waitForNextTick(instances, instance, sleepMs);
        }).pipe(Effect.forever);

      return { latest: Ref.get(latestCycle), run, tick };
    }),
  );
}
