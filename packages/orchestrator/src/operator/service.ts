import type { LoadedInstance } from "@usine/config";
import { Event, Loop, Run } from "@usine/core";
import {
  LoopControl,
  RunEngine,
  RunReader,
  type EnginePersistenceError,
  type LoopRuntimeState,
  type ProjectionRevision,
  type RunEngineError,
  type RunStoreError,
} from "@usine/engine";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  SynchronizedRef,
} from "effect";
import {
  PollingTriggers,
  type RepositoryPollFailure,
} from "../polling-triggers.ts";
import {
  ScheduleTriggers,
  type ScheduleFailure,
} from "../schedule-triggers.ts";
import {
  ApprovalNeed,
  ColdTranscriptRequest,
  LoopView,
  PollFailureNeed,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunFailureNeed,
  ScheduleFailureNeed,
  type TranscriptAttemptNotFoundError,
  type TranscriptRequest,
  type NeedView,
  type ProjectStatus,
} from "./model.ts";
import { readTranscript, runView } from "./projection.ts";

export type OperatorError = RunEngineError | TranscriptAttemptNotFoundError;
export type OperatorObservationError =
  | RunStoreError
  | TranscriptAttemptNotFoundError;

/** Settled Runs kept in the overview beside every open one; history stays bounded. */
const OVERVIEW_CLOSED_RUNS = 100;

interface CachedOverview {
  readonly token: string;
  readonly overview: ReadyOverview;
}

const makeOperatorObservation = Effect.gen(function* () {
  const reader = yield* RunReader;
  const controls = yield* LoopControl;
  const polling = yield* PollingTriggers;
  const schedules = yield* ScheduleTriggers;
  const cache = yield* SynchronizedRef.make(Option.none<CachedOverview>());

  const projectOverview = Effect.fn("Operator.projectOverview")(function* (
    instance: LoadedInstance,
    pollFailures: ReadonlyArray<RepositoryPollFailure>,
    scheduleFailures: ReadonlyArray<ScheduleFailure>,
    revision: Option.Option<ProjectionRevision>,
  ) {
    const [snapshots, states] = yield* Effect.all(
      [
        reader.list({ closedLimit: OVERVIEW_CLOSED_RUNS }),
        controls.states,
      ] as const,
      { concurrency: "unbounded" },
    );
    const paused = new Set(
      states.filter((state) => state.paused).map((state) => state.loop),
    );
    const views = snapshots.map((snapshot) => runView(snapshot, paused));
    const runsByRepository = new Map<string, Array<(typeof views)[number]>>();
    for (const view of views) {
      const projectRuns = runsByRepository.get(view.repository) ?? [];
      projectRuns.push(view);
      runsByRepository.set(view.repository, projectRuns);
    }
    const projects = instance.config.repos.map(({ name }) => {
      const projectRuns = runsByRepository.get(name) ?? [];
      const status: ProjectStatus = projectRuns.some(
        (run) => run.state === "Waiting" || run.state === "Failed",
      )
        ? "needs-you"
        : projectRuns.some((run) => run.canCancel)
          ? "active"
          : "clear";
      return new ProjectView({ repository: name, status, runs: projectRuns });
    });
    const loops = instance.loops.map(
      (loop) =>
        new LoopView({
          name: loop.name,
          trigger: loop.trigger.on,
          agent: loop.agent,
          paused: paused.has(loop.name),
        }),
    );
    const needsYou: Array<NeedView> = [];
    for (const run of views) {
      if (run.state === "Waiting") {
        needsYou.push(
          new ApprovalNeed({
            id: `approval:${run.id}`,
            repository: run.repository,
            runId: run.id,
            loop: run.loop,
          }),
        );
      } else if (run.state === "Failed") {
        const attempt = run.attempts.at(-1);
        if (attempt?.outcome?._tag !== "Failed") {
          return yield* Effect.die(
            new Error(`Failed Run ${run.id} has no failed Attempt`),
          );
        }
        needsYou.push(
          new RunFailureNeed({
            id: `run-failure:${run.id}`,
            repository: run.repository,
            runId: run.id,
            loop: run.loop,
            failure: attempt.outcome.failure,
          }),
        );
      }
    }
    pollFailures.forEach((failure, index) => {
      needsYou.push(
        new PollFailureNeed({
          id: `poll-failure:${failure.repository}:${failure.errorTag}:${index}`,
          failure,
        }),
      );
    });
    scheduleFailures.forEach((failure, index) => {
      needsYou.push(
        new ScheduleFailureNeed({
          id: `schedule-failure:${failure.loop}:${failure._tag}:${index}`,
          failure,
        }),
      );
    });
    const projected = new ReadyOverview({ projects, loops, needsYou });
    yield* Effect.logDebug("Refreshed operator overview", {
      revision,
      runs: views.length,
      needsYou: needsYou.length,
    });
    return projected;
  });

  const overview = Effect.fn("Operator.overview")((instance: LoadedInstance) =>
    SynchronizedRef.modifyEffect(cache, (cached) =>
      Effect.gen(function* () {
        const [revision, latestPoll, latestSchedule] = yield* Effect.all(
          [reader.revision(), polling.latest, schedules.latest] as const,
          { concurrency: "unbounded" },
        );
        const pollFailures = Option.match(latestPoll, {
          onNone: () => [],
          onSome: ({ failures }) => failures,
        });
        const scheduleFailures = Option.match(latestSchedule, {
          onNone: () => [],
          onSome: ({ failures }) => failures,
        });
        // A missing invalidation singleton means staleness is undetectable, so the
        // cache is bypassed entirely rather than trusted.
        const token = Option.map(revision, (value) =>
          JSON.stringify([
            value,
            instance.config.repos.map(({ name }) => name),
            instance.loops.map(({ name, agent, trigger }) => [
              name,
              agent,
              trigger.on,
            ]),
            pollFailures,
            scheduleFailures,
          ]),
        );
        if (Option.isNone(token)) {
          yield* Effect.logWarning(
            "Projection revision singleton is missing; the overview cache is bypassed",
          );
          const projected = yield* projectOverview(
            instance,
            pollFailures,
            scheduleFailures,
            revision,
          );
          return [projected, Option.none<CachedOverview>()] as const;
        }
        if (Option.isSome(cached) && cached.value.token === token.value) {
          yield* Effect.logDebug("Reusing unchanged operator overview", {
            revision,
          });
          return [cached.value.overview, cached] as const;
        }
        const projected = yield* projectOverview(
          instance,
          pollFailures,
          scheduleFailures,
          revision,
        );
        return [
          projected,
          Option.some({ token: token.value, overview: projected }),
        ] as const;
      }),
    ),
  );

  const detail = Effect.fn("Operator.detail")(function* (
    runId: Run.RunId,
    request: TranscriptRequest = new ColdTranscriptRequest(),
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    const [snapshot, states] = yield* Effect.all(
      [reader.inspect(runId), controls.states] as const,
      { concurrency: "unbounded" },
    );
    const paused = new Set(
      states.filter((state) => state.paused).map((state) => state.loop),
    );
    const transcript = yield* readTranscript(reader, snapshot, request);
    return new RunDetailView({
      run: runView(snapshot, paused),
      eventDedupKey: snapshot.event.dedupKey,
      eventPayload: snapshot.event.payload,
      transcript: transcript.events,
      earlierTranscript: transcript.earlier,
    });
  });

  return { detail, overview } as const;
});

/** Read-only operator surface; safe to build without trigger execution. */
export class OperatorObservation extends Context.Service<
  OperatorObservation,
  {
    readonly overview: (
      instance: LoadedInstance,
    ) => Effect.Effect<ReadyOverview, OperatorObservationError>;
    readonly detail: (
      runId: Run.RunId,
      request?: TranscriptRequest,
    ) => Effect.Effect<RunDetailView, OperatorObservationError>;
  }
>()("@usine/orchestrator/OperatorObservation") {
  static readonly layer = Layer.effect(
    OperatorObservation,
    makeOperatorObservation,
  );
}

const makeOperator = Effect.gen(function* () {
  const observation = yield* OperatorObservation;
  const runs = yield* RunEngine;
  const controls = yield* LoopControl;

  const approve = Effect.fn("Operator.approve")(function* (runId: Run.RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    const receivedAt = yield* DateTime.now;
    const dedupKey = Event.DedupKey.make(
      JSON.stringify(["operator-approval", runId]),
    );
    yield* runs.approve(
      runId,
      new Event.Event({
        id: Event.EventId.make(dedupKey),
        dedupKey,
        payload: { runId, decision: "approved" },
        receivedAt,
      }),
    );
    yield* Effect.logInfo("Operator approved Run", { runId });
  });

  const retry = Effect.fn("Operator.retry")(function* (runId: Run.RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    yield* runs.retry(runId);
    yield* Effect.logInfo("Operator retried Run", { runId });
  });

  const cancel = Effect.fn("Operator.cancel")(function* (runId: Run.RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    yield* runs.cancel(runId);
    yield* Effect.logInfo("Operator canceled Run", { runId });
  });

  const pause = Effect.fn("Operator.pause")(function* (loop: Loop.LoopName) {
    yield* Effect.annotateCurrentSpan({ loop });
    return yield* controls.pause(loop);
  });
  const unpause = Effect.fn("Operator.unpause")(function* (
    loop: Loop.LoopName,
  ) {
    yield* Effect.annotateCurrentSpan({ loop });
    return yield* controls.unpause(loop);
  });

  return { ...observation, approve, cancel, pause, retry, unpause } as const;
});

/** Observe-and-intervene application service; transports only translate this API. */
export class Operator extends Context.Service<
  Operator,
  OperatorObservation["Service"] & {
    readonly approve: (runId: Run.RunId) => Effect.Effect<void, OperatorError>;
    readonly retry: (runId: Run.RunId) => Effect.Effect<void, OperatorError>;
    readonly cancel: (runId: Run.RunId) => Effect.Effect<void, OperatorError>;
    readonly pause: (
      loop: Loop.LoopName,
    ) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
    readonly unpause: (
      loop: Loop.LoopName,
    ) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
  }
>()("@usine/orchestrator/Operator") {
  static readonly layer = Layer.effect(Operator, makeOperator).pipe(
    Layer.provide(OperatorObservation.layer),
  );
}
