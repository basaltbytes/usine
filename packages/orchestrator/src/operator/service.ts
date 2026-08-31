import type { LoadedInstance } from "@usine/config";
import { Event, Loop, Run } from "@usine/core";
import { LoopControl, RunEngine, type RunEngineError } from "@usine/engine";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { PollingTriggers } from "../polling-triggers.ts";
import {
  ScheduleAgentFailure,
  ScheduleCronFailure,
  ScheduleTriggers,
} from "../schedule-triggers.ts";
import {
  LoopView,
  NeedView,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  type ProjectStatus,
  type TranscriptCursor,
} from "./model.ts";
import { readTranscript, runView } from "./projection.ts";

export type OperatorError = RunEngineError;

const makeOperator = Effect.gen(function* () {
  const runs = yield* RunEngine;
  const controls = yield* LoopControl;
  const polling = yield* PollingTriggers;
  const schedules = yield* ScheduleTriggers;

  const overview = Effect.fn("Operator.overview")(function* (instance: LoadedInstance) {
    const [snapshots, states, latestPoll, latestSchedule] = yield* Effect.all(
      [runs.list(), controls.states, polling.latest, schedules.latest] as const,
      { concurrency: "unbounded" },
    );
    const paused = new Set(states.filter((state) => state.paused).map((state) => state.loop));
    const views = snapshots.map(runView);
    const projects = instance.config.repos.map(({ name }) => {
      const projectRuns = views.filter((run) => run.repository === name);
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
          new NeedView({
            id: `approval:${run.id}`,
            kind: "approval",
            title: "Approval required",
            detail: `${run.loop} is waiting to run on ${run.repository}.`,
            repository: run.repository,
            runId: run.id,
            loop: run.loop,
          }),
        );
      } else if (run.state === "Failed") {
        const attempt = run.attempts.at(-1);
        needsYou.push(
          new NeedView({
            id: `run-failure:${run.id}`,
            kind: "run-failure",
            title: attempt?.errorTag ?? "Run failed",
            detail: attempt?.errorMessage ?? `${run.loop} failed on ${run.repository}.`,
            repository: run.repository,
            runId: run.id,
            loop: run.loop,
          }),
        );
      }
    }
    if (Option.isSome(latestPoll)) {
      latestPoll.value.failures.forEach((failure, index) => {
        needsYou.push(
          new NeedView({
            id: `poll-failure:${failure.repository}:${index}`,
            kind: "poll-failure",
            title: failure.errorTag,
            detail: failure.message,
            repository: failure.repository,
            runId: null,
            loop: null,
          }),
        );
      });
    }
    if (Option.isSome(latestSchedule)) {
      latestSchedule.value.failures.forEach((failure, index) => {
        const title =
          "errorTag" in failure
            ? failure.errorTag
            : failure instanceof ScheduleCronFailure
              ? "ScheduleCronFailure"
              : failure instanceof ScheduleAgentFailure
                ? "ScheduleAgentFailure"
                : "ScheduleFailure";
        needsYou.push(
          new NeedView({
            id: `schedule-failure:${failure.loop}:${index}`,
            kind: "schedule-failure",
            title,
            detail: failure.message,
            repository: "repository" in failure ? failure.repository : null,
            runId: null,
            loop: failure.loop,
          }),
        );
      });
    }
    return new ReadyOverview({ projects, loops, needsYou });
  });

  const detail = Effect.fn("Operator.detail")(function* (
    runId: Run.RunId,
    after: Option.Option<TranscriptCursor> = Option.none(),
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    const snapshot = yield* runs.inspect(runId);
    return new RunDetailView({
      run: runView(snapshot),
      eventDedupKey: snapshot.event.dedupKey,
      eventPayload: snapshot.event.payload,
      transcript: yield* readTranscript(runs, snapshot, after),
    });
  });

  const approve = Effect.fn("Operator.approve")(function* (runId: Run.RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    const receivedAt = yield* DateTime.now;
    const dedupKey = Event.DedupKey.make(JSON.stringify(["operator-approval", runId]));
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
  });

  const pause = Effect.fn("Operator.pause")((loop: Loop.LoopName) => controls.pause(loop));
  const unpause = Effect.fn("Operator.unpause")((loop: Loop.LoopName) => controls.unpause(loop));

  return { approve, cancel, detail, overview, pause, retry, unpause } as const;
});

/** Observe-and-intervene application service; transports only translate this API. */
export class Operator extends Context.Service<Operator, Effect.Success<typeof makeOperator>>()(
  "@usine/orchestrator/Operator",
) {
  static readonly layer = Layer.effect(Operator, makeOperator);
}
