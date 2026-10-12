import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Settings, UsineConfig } from "@usine/config/factory";
import { SessionTokensUpdated, TokenCount } from "@usine/core/agent/session";
import { Attempt, AttemptId, AttemptNumber } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { InstanceDirectory } from "@usine/core/instance";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { RunEngine } from "@usine/engine/engine";
import { StepExecution, StepExecutor } from "@usine/engine/step-executor";
import { layer as localExecutorLayer } from "@usine/executor/local";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { layer as localLayer } from "../../src/local.ts";
import { stepExecutorLayer } from "../../src/scheduler.ts";
import { type StubParent, stubAttemptRuntime, StubStorage } from "@usine/durable/testing";
import { alwaysHoldsLayer } from "../support/polling.ts";
import {
  LIVE_TEST_TIMEOUT,
  config,
  credentialLayer,
  harnessReady,
  makeRemote,
  submission,
  testAgent,
  waitFor,
} from "./support.ts";

/** One fresh Attempt of a Run, as the engine hands it to the StepExecutor. */
const freshExecution = (runId: RunId, attemptId: AttemptId) => {
  const selected = submission(5);
  return new StepExecution({
    attempt: new Attempt({
      task: selected.task,
      agent: selected.agent.name,
      operatorIntervened: false,
      id: attemptId,
      runId,
      stepName: selected.step,
      worker: WorkerName.make("local"),
      number: AttemptNumber.make(1),
      brain: testAgent.brain,
      parentModel: Option.none(),
      startedAt: selected.event.receivedAt,
      outcome: Option.none(),
      salvage: Option.none(),
    }),
    event: selected.event,
    run: new Run({
      id: runId,
      eventId: selected.event.id,
      loop: selected.loop,
      state: RunState.start(new RunState.Pending()),
      openedAt: selected.event.receivedAt,
    }),
    step: new Step({ runId, name: selected.step, result: Option.none() }),
    repository: selected.repository,
    revision: selected.revision,
    task: selected.task,
    agent: selected.agent,
    parentModel: selected.parentModel,
    resume: Option.none(),
  });
};

describe("local worker runaway guard", () => {
  it.live(
    "stops the parent task when the token ceiling trips instead of leaving it live",
    () => {
      const storage = new StubStorage();
      const spender: StubParent = ({ emit, session }) =>
        emit(
          new AttemptChannel.SessionEvent({
            event: new SessionTokensUpdated({ session, totalTokens: TokenCount.make(150) }),
          }),
        ).pipe(Effect.andThen(Effect.never));
      const ceiling = new UsineConfig({
        ...config,
        settings: new Settings({ ...config.settings, maxAttemptTokens: Option.some(100) }),
      });
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-ceiling-" });
        const instance = InstanceDirectory.make(root);
        const remote = yield* makeRemote(root);
        const runtime = localLayer(instance, ceiling, [], {
          repositoryUrl: () => remote,
          interruptGrace: "100 millis",
          harnessReadiness: harnessReady,
        }).pipe(
          Layer.provide(credentialLayer),
          Layer.provide(stubAttemptRuntime(storage, spender)),
          Layer.provide(alwaysHoldsLayer),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission(4));
          assert(accepted._tag === "Claimed");
          const failed = yield* waitFor(engine, accepted.runId, "Failed");
          const outcome = Option.getOrUndefined(failed.attempts[0]?.outcome ?? Option.none());
          assert(outcome?._tag === "Failed");
          assert.strictEqual(outcome.failure._tag, "RunawayFailure");
          const attemptId = failed.attempts[0]?.id;
          assert(attemptId !== undefined);
          assert.strictEqual(storage.tasks.get(attemptId)?.state._tag, "canceled");
        }).pipe(Effect.provide(runtime));
      }).pipe(Effect.provide(NodeServices.layer));
    },
    LIVE_TEST_TIMEOUT,
  );

  it.effect(
    "stops the parent task when the wall-clock ceiling trips instead of leaving it live",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-clock-" });
        const remote = yield* makeRemote(root);
        const storage = new StubStorage();
        const started = yield* Deferred.make<void>();
        const idle: StubParent = () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        const executor = localExecutorLayer({
          instanceDirectory: InstanceDirectory.make(root),
          repositoryUrl: () => remote,
          harnessReadiness: harnessReady,
        }).pipe(Layer.provide(credentialLayer), Layer.provide(stubAttemptRuntime(storage, idle)));
        const ceiling = new UsineConfig({
          ...config,
          settings: new Settings({ ...config.settings, maxAttemptMinutes: Option.some(1) }),
        });
        yield* Effect.gen(function* () {
          const scheduler = yield* StepExecutor;
          const attemptId = AttemptId.make("wall-clock-run/execute/1");
          const running = yield* scheduler
            .execute(freshExecution(RunId.make("wall-clock-run"), attemptId), {
              append: () => Effect.void,
              salvage: () => Effect.void,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          // One second at a time, so the guard arms its next timer after the warning.
          for (let second = 0; second < 90 && running.pollUnsafe() === undefined; second += 1) {
            yield* TestClock.adjust("1 second");
          }
          const failure = yield* Fiber.join(running).pipe(Effect.flip);
          assert(failure._tag === "RunawayFailure");
          assert.strictEqual(failure.ceiling, "wall-clock");
          assert.strictEqual(storage.tasks.get(attemptId)?.state._tag, "canceled");
          assert.deepStrictEqual(
            yield* fileSystem.readDirectory(`${root}/.usine/workers/local/attempts`),
            [],
          );
        }).pipe(Effect.provide(stepExecutorLayer(ceiling, []).pipe(Layer.provide(executor))));
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );
});
