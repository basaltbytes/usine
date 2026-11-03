import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Event, EventId, DedupKey } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { RunId } from "@usine/core/run";
import { StepResult } from "@usine/core/step/result";
import { RunEngine, Submission } from "@usine/engine/engine";
import { layer as engineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import { Executor, ExecutorError } from "@usine/executor";
import { InfraFailure } from "@usine/core/attempt/failure";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { serverLayer } from "../src/http.ts";
import { FactoryBackend } from "../src/backend.ts";
import { Port } from "../src/cli.ts";
import { authFixture } from "./auth/fixture.ts";
import { assert, it } from "vitest";
import { committedBeforeCrash, submission } from "../../../packages/engine/test/support.ts";
import {
  ADDRESS,
  WORKER,
  executorLayer,
  fakeMachine,
  mintingProvider,
  noGateway,
  COMMIT_AUTHOR,
} from "../../../packages/executor/test/ssh/support.ts";
import { startupListener } from "../src/listener.ts";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";

it("answers the version while recovering 400 finished attempts without per-attempt remote commands", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() }),
      );
      const template = submission({ number: 1 });
      yield* committedBeforeCrash(directory, (store) =>
        Effect.gen(function* () {
          for (let index = 0; index < 400; index += 1) {
            const runId = RunId.make(`finished-${index}`);
            const value = Submission.make({
              ...template,
              itemKey: ItemKey.make(`item-${index}`),
              event: Event.make({
                ...template.event,
                id: EventId.make(`event-${index}`),
                dedupKey: DedupKey.make(`event-${index}`),
              }),
            });
            yield* store.recordAndClaim(value, runId);
            const started = yield* store.beginAttempt(runId, WORKER, Option.none());
            assert(started._tag === "AttemptStarted");
            yield* store.finishAttempt(
              started.execution.attempt,
              Result.succeed(StepResult.make({ message: "done", facts: [] })),
            );
          }
        }),
      );
      const machine = fakeMachine();
      const connectionWrites: Array<string> = [];
      const executor = executorLayer(machine, mintingProvider(), ADDRESS, undefined, undefined, {
        attemptConnections: {
          read: () => Effect.succeedNone,
          write: (id) => Effect.sync(() => void connectionWrites.push(id)),
          remove: () => Effect.void,
        },
      }).pipe(Layer.provide(noGateway));
      const recovering = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let recovered = 0;
      let firstCommands = 0;
      const scheduler = Layer.effect(
        StepExecutor,
        Effect.gen(function* () {
          const remote = yield* Executor;
          return StepExecutor.of({
            workers: Effect.succeed([WORKER]),
            isLive: remote.isLive,
            outcome: remote.outcome,
            recover: (attempt, sink) =>
              Effect.gen(function* () {
                yield* remote
                  .recover(attempt, sink, Effect.succeed(COMMIT_AUTHOR))
                  .pipe(
                    Effect.catchIf(Schema.is(ExecutorError), (error) =>
                      InfraFailure.make({ message: error.message, cause: error }),
                    ),
                  );
                recovered += 1;
                if (recovered === 1) {
                  firstCommands = machine.state.calls.length;
                  yield* Deferred.succeed(recovering, undefined);
                  yield* Deferred.await(finish);
                }
              }),
            occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
            reserve: () => Effect.die("finished runs start no attempt"),
            execute: () => Effect.die("finished runs start no attempt"),
            intervene: () => Effect.die("unused"),
            interrupt: () => Effect.void,
            sweep: Effect.void,
            discard: () => Effect.void,
          });
        }),
      ).pipe(Layer.provide(executor));
      const runtime = engineLayer(directory).pipe(
        Layer.provide(scheduler),
        Layer.provide(
          Layer.succeed(TriggerCondition)({ recheck: () => Effect.succeed("matches") }),
        ),
      );
      const listener = yield* startupListener("0.5.1-next.341");
      const starting = yield* Layer.build(runtime).pipe(Effect.forkChild);
      yield* Deferred.await(recovering);
      const client = yield* HttpClient.HttpClient;
      const version = yield* client.get("/api/version");
      assert.strictEqual(version.status, 200);
      assert.strictEqual(yield* version.json, "0.5.1-next.341");
      assert.strictEqual(recovered, 1, "the API answers before reconciliation finishes");
      const notReady = yield* client.get("/api/ready");
      assert.strictEqual(notReady.status, 503);
      assert.strictEqual(notReady.headers["retry-after"], "1");
      const waiting = yield* client.post("/api/runs");
      assert.strictEqual(waiting.status, 503);
      yield* Deferred.succeed(finish, undefined);
      const context = yield* Fiber.join(starting);
      assert(Context.get(context, RunEngine));
      assert.strictEqual(recovered, 400);
      assert.strictEqual(
        machine.state.calls.length,
        firstCommands,
        "finished attempts add no remote command",
      );
      assert.deepStrictEqual(connectionWrites, []);
      const auth = yield* authFixture();
      yield* Layer.build(
        serverLayer(
          Layer.mock(FactoryBackend)({}),
          directory,
          Port.make(7331),
          auth,
          Layer.empty,
          Layer.empty,
          undefined,
          listener,
        ),
      );
      const readiness = yield* client.get("/api/ready");
      assert.strictEqual(readiness.status, 200);
      assert.deepStrictEqual(yield* readiness.json, { ok: true });
      const ready = yield* client.get("/api/overview");
      assert.strictEqual(
        ready.status,
        401,
        "runtime routes replace startup responses on the same listener",
      );
      assert.strictEqual(ready.headers["x-frame-options"], "DENY");
    }).pipe(Effect.scoped, Effect.provide([NodeHttpServer.layerTest, NodeServices.layer])),
  );
}, 30_000);
