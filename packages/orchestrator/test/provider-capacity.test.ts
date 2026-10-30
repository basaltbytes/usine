import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { LocalProcess } from "@usine/agents/child-host";
import { CodexAppServer, codexChildBackendLayer } from "@usine/agents/codex";
import {
  ChildRequest,
  CodexChildBackend,
  WorkingDirectory,
  toAttemptFailure,
} from "@usine/agents/runtime";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AttemptTask, pendingProviderRetry } from "@usine/core/attempt";
import { SalvagePushed, SalvageRef } from "@usine/core/attempt/salvage";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { RunEngine, RetryRequest, Submission } from "@usine/engine/engine";
import { layer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import { DateTime, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { runView } from "../src/operator/projection.ts";

const capacityMessage = "Selected model is at capacity. Please try a different model.";
const brain = new BrainSpec({ harness: "codex", model: ModelId.make("gpt-test"), effort: "high" });
const agent = new Agent({
  name: AgentName.make("developer"),
  brain,
  persona: AgentPersona.make("Finish the task"),
  parentModel: Option.none(),
  parentEffort: Option.none(),
});
const worker = WorkerName.make("local");
const salvage = new SalvagePushed({
  ref: SalvageRef.make("usine/salvage/capacity/1"),
  commit: CommitSha.make("a".repeat(40)),
});
const submission = new Submission({
  event: new Event({
    id: EventId.make("capacity"),
    dedupKey: DedupKey.make("capacity"),
    payload: {},
    receivedAt: DateTime.makeUnsafe(0),
  }),
  itemKey: ItemKey.make("issue:692"),
  loop: LoopName.make("develop"),
  step: StepName.make("run"),
  approval: "none",
  repository: RepositoryName.make("basaltbytes/usine"),
  revision: RepositoryRevision.make("main"),
  task: AttemptTask.make("Finish the task"),
  agent,
  parentModel: Option.none(),
});

const inspectUntil = (
  engine: RunEngine["Service"],
  runId: RunId,
  done: (snapshot: Effect.Success<ReturnType<RunEngine["Service"]["inspect"]>>) => boolean,
) =>
  Effect.gen(function* () {
    for (let count = 0; count < 1_000; count += 1) {
      const snapshot = yield* engine.inspect(runId);
      if (done(snapshot)) return snapshot;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("Run did not reach the expected state");
  });

it.effect.each(["success", "restart", "cancel", "cap", "ordinary"] as const)(
  "handles a scripted Codex refusal through the engine: %s",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() }),
      );
      let calls = 0;
      let leased = false;
      const server = Layer.succeed(CodexAppServer)({
        open: () =>
          Effect.sync(() => {
            calls += 1;
            const fails = calls === 1 || scenario === "cap";
            const responses = new Map<string, Schema.Json>(
              Object.entries({
                initialize: {},
                "account/read": { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
                "model/list": { data: [{ id: "gpt-test", model: "gpt-test" }], nextCursor: null },
                "thread/start": {
                  thread: { id: "thread" },
                  model: "gpt-test",
                  instructionSources: [],
                },
                "turn/start": { turn: { id: "turn" } },
              }),
            );
            return {
              close: Effect.void,
              notify: () => Effect.void,
              request: (_operation, method) => Effect.succeed(responses.get(method) ?? {}),
              notifications: Stream.make({
                method: "turn/completed",
                params: {
                  turn: {
                    id: "turn",
                    status: fails ? "failed" : "completed",
                    error: fails
                      ? {
                          message: scenario === "ordinary" ? "Task checks failed" : capacityMessage,
                          additionalDetails: null,
                        }
                      : null,
                  },
                },
              }),
            };
          }),
      });
      const backend = codexChildBackendLayer.pipe(Layer.provide(server));
      const executor = Layer.effect(
        StepExecutor,
        Effect.gen(function* () {
          const codex = yield* CodexChildBackend;
          return {
            workers: Effect.succeed([worker]),
            isLive: () => Effect.succeed(false),
            outcome: () => Effect.succeed(Option.none()),
            recover: () => Effect.void,
            intervene: () => Effect.void,
            interrupt: () => Effect.void,
            occupy: () => Effect.succeed({ worker, release: Effect.void }),
            sweep: Effect.void,
            discard: () => Effect.void,
            reserve: () =>
              Effect.sync(() => {
                assert.isFalse(leased);
                leased = true;
                return {
                  worker,
                  release: Effect.sync(() => {
                    leased = false;
                  }),
                };
              }),
            execute: (execution, sink) =>
              Effect.scoped(
                Effect.gen(function* () {
                  if (execution.attempt.number > 1)
                    assert.deepStrictEqual(execution.resume, Option.some(salvage));
                  const child = yield* codex.launch(
                    new ChildRequest({
                      session: new ChildSession({
                        id: AgentSessionId.make(`child-${execution.attempt.number}`),
                        parentId: AgentSessionId.make("parent"),
                        agent: agent.name,
                        brain,
                      }),
                      cwd: WorkingDirectory.make(directory),
                      prompt: execution.task,
                      environment: {},
                      host: new LocalProcess(),
                      worker,
                      machine: Option.none(),
                    }),
                  );
                  const result = yield* child.result;
                  return new StepResult({ message: result.message, facts: [] });
                }),
              ).pipe(
                Effect.mapError(toAttemptFailure),
                Effect.tapError(() => sink.salvage(salvage)),
              ),
          } satisfies StepExecutor["Service"];
        }),
      ).pipe(Layer.provide(backend));
      const condition = Layer.succeed(TriggerCondition)({
        recheck: () => Effect.succeed("matches"),
      });
      const runtime = layer(directory).pipe(Layer.provide(executor), Layer.provide(condition));
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission);
          assert(accepted._tag === "Claimed");
          const failed = yield* inspectUntil(
            engine,
            accepted.runId,
            (s) => Option.isSome(s.attempts[0]?.endedAt ?? Option.none()) && !leased,
          );
          if (scenario === "ordinary") {
            assert.strictEqual(failed.run.state._tag, "Failed");
            assert.isNull(runView(failed, new Set(), new Map()).providerRetry);
            assert.strictEqual(calls, 1);
            return accepted.runId;
          }
          const retry = pendingProviderRetry(failed.run.state, failed.attempts);
          assert(Option.isSome(retry));
          assert.strictEqual(DateTime.toEpochMillis(retry.value.retryAt), 120_000);
          const view = runView(failed, new Set(), new Map());
          assert.strictEqual(view.providerRetry?.message, capacityMessage);
          assert.strictEqual(view.providerRetry?.nextAttempt, 2);
          yield* TestClock.adjust("119 seconds");
          assert.strictEqual(calls, 1);
          assert.isFalse(leased);
          if (scenario === "restart") return accepted.runId;
          if (scenario === "cancel") {
            yield* engine.cancel(accepted.runId);
            yield* TestClock.adjust("10 minutes");
            assert.strictEqual(calls, 1);
            assert.strictEqual((yield* engine.inspect(accepted.runId)).run.state._tag, "Canceled");
            return accepted.runId;
          }
          yield* TestClock.adjust("1 second");
          if (scenario === "cap") {
            const second = yield* inspectUntil(
              engine,
              accepted.runId,
              (s) =>
                s.attempts.length === 2 &&
                Option.isSome(s.attempts[1]?.endedAt ?? Option.none()) &&
                !leased,
            );
            assert.strictEqual(
              Option.getOrNull(pendingProviderRetry(second.run.state, second.attempts))
                ?.nextAttempt,
              3,
            );
            yield* TestClock.adjust("299 seconds");
            assert.strictEqual(calls, 2);
            yield* TestClock.adjust("1 second");
            const exhausted = yield* inspectUntil(
              engine,
              accepted.runId,
              (s) => s.run.state._tag === "Failed",
            );
            assert.strictEqual(exhausted.attempts.length, 3);
            assert.isNull(runView(exhausted, new Set(), new Map()).providerRetry);
            yield* engine.retry(
              accepted.runId,
              new RetryRequest({ requestedBy: Option.none(), amendment: Option.none() }),
            );
            const retried = yield* inspectUntil(
              engine,
              accepted.runId,
              (s) => s.attempts.length === 4 && s.run.state._tag === "Failed",
            );
            assert.strictEqual(calls, 4);
            assert.strictEqual(
              Option.getOrNull(retried.attempts[3]?.start ?? Option.none())?._tag,
              "OperatorRetry",
            );
          } else {
            const finished = yield* inspectUntil(
              engine,
              accepted.runId,
              (s) => s.run.state._tag === "Succeeded",
            );
            assert.strictEqual(finished.attempts.length, 2);
            assert.strictEqual(
              Option.getOrNull(finished.attempts[1]?.start ?? Option.none())?._tag,
              "ProviderRetry",
            );
          }
          return accepted.runId;
        }).pipe(Effect.provide(runtime)),
      );
      if (scenario === "restart")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* RunEngine;
            yield* TestClock.adjust("999 millis");
            assert.strictEqual(calls, 1);
            yield* TestClock.adjust("1 millis");
            const finished = yield* inspectUntil(
              engine,
              first,
              (s) => s.run.state._tag === "Succeeded",
            );
            assert.strictEqual(finished.attempts.length, 2);
          }).pipe(Effect.provide(runtime)),
        );
    }).pipe(Effect.provide(NodeServices.layer)),
);
