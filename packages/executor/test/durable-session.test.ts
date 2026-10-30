import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { LocalProcess } from "@usine/agents/child-host";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RunawayFailure } from "@usine/core/attempt/failure";
import { CommitSha } from "@usine/core/repository";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { answer, layer, PARENT_MODEL } from "@usine/durable/testing";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option } from "effect";
import { durableSessionFor, type DurableCheckout } from "../src/durable-session.ts";
import { AttemptWorkspace, WorktreePath } from "../src/executor.ts";
import { recording, request } from "./exe-dev/support.ts";

const workspace = new AttemptWorkspace({
  worker: request.worker,
  worktree: WorktreePath.make("/workspace/usine"),
  spec: new AttemptChannel.RunSpec({
    ...request,
    baseCommit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
    parentModel: Option.some(PARENT_MODEL),
    preparedAt: Option.none(),
  }),
});

const checkout: DurableCheckout = {
  host: new LocalProcess(),
  machine: Option.none(),
  environment: {},
  gatewayCredential: Effect.succeedNone,
  harvest: () => Effect.die("A failed relay must not harvest a result"),
  harvestComments: () => Effect.succeed([]),
  harvestKeptComments: () => Effect.succeed([]),
  keepForReattach: Effect.die("A failed relay must stop the attempt"),
  keepUntilStopped: Effect.die("The terminal parent can be confirmed stopped"),
  reconcileKept: () => Effect.void,
};

describe("durable session settlement", () => {
  for (const terminal of ["completed", "failed"] as const) {
    it.live(
      `settles a ${terminal} task after its terminal append fails and skips cancellation on later startups`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: sqliteTempDirectory(),
            prefix: "usine-settle-",
          });
          const database = `${directory}/durable.sqlite`;
          let cancellations = 0;
          const runtimeLayer = Layer.effect(
            AttemptRuntime,
            Effect.map(AttemptRuntime, (runtime) =>
              AttemptRuntime.of({
                ...runtime,
                cancel: (attemptId) =>
                  Effect.sync(() => {
                    cancellations += 1;
                  }).pipe(Effect.andThen(runtime.cancel(attemptId))),
              }),
            ),
          ).pipe(
            Layer.provide(
              layer({
                database,
                parent: [
                  answer(
                    terminal === "completed" ? "Done." : "[usine:blocked]\nMissing credentials.",
                  ),
                ],
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const runtime = yield* AttemptRuntime;
            const session = yield* durableSessionFor({ interruptGrace: "1 second" });
            const sink: AttemptChannel.Sink = {
              ...recording().sink,
              append: (_direction, envelope) =>
                envelope._tag === "OutboundEnvelope" &&
                (envelope.payload._tag === "Final" || envelope.payload._tag === "Failed")
                  ? Effect.fail(new RunawayFailure({ ceiling: "tokens" }))
                  : Effect.void,
            };
            const failure = yield* session.launch(workspace, sink, checkout).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "RunawayFailure");
            assert.strictEqual(cancellations, 1);
            assert.isFalse(yield* runtime.isLive(request.attemptId));
            assert.isTrue(Option.isNone(yield* runtime.finished(request.attemptId)));
            assert.isFalse(yield* session.isLive(request.attemptId));
            yield* runtime.settle(request.attemptId);
            assert.isTrue(Option.isNone(yield* runtime.finished(request.attemptId)));
          }).pipe(Effect.scoped, Effect.provide(runtimeLayer));

          for (let startup = 0; startup < 2; startup += 1) {
            yield* Effect.gen(function* () {
              const session = yield* durableSessionFor({ interruptGrace: "1 second" });
              yield* session.stopForRecovery({
                attemptId: request.attemptId,
                worker: request.worker,
                repository: request.repository,
                ref: request.salvageRef,
                permissions: request.permissions,
                succeeded: false,
                open: false,
                rejected: Option.none(),
              });
              assert.isFalse(yield* session.isLive(request.attemptId));
              assert.strictEqual(cancellations, 1);
            }).pipe(Effect.scoped, Effect.provide(runtimeLayer));
          }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.live("leaves a drained task unsettled when its terminal relay fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-drain-",
      });
      yield* Effect.gen(function* () {
        const runtime = yield* AttemptRuntime;
        const terminal = yield* Deferred.make<void>();
        const draining = yield* Deferred.make<void>();
        const session = yield* durableSessionFor({ interruptGrace: "1 second" }).pipe(
          Effect.provideService(AttemptRuntime, {
            ...runtime,
            cancel: (attemptId) =>
              Deferred.succeed(draining, undefined).pipe(Effect.andThen(runtime.cancel(attemptId))),
          }),
        );
        const sink: AttemptChannel.Sink = {
          ...recording().sink,
          append: (_direction, envelope) =>
            envelope._tag === "OutboundEnvelope" && envelope.payload._tag === "Final"
              ? Deferred.succeed(terminal, undefined).pipe(
                  Effect.andThen(Deferred.await(draining)),
                  Effect.andThen(new RunawayFailure({ ceiling: "tokens" })),
                )
              : Effect.void,
        };
        const launched = yield* session.launch(workspace, sink, checkout).pipe(Effect.forkChild);
        yield* Deferred.await(terminal);
        assert.isTrue(yield* session.drain(request.attemptId, "The worker is stopping"));
        const failure = yield* Fiber.join(launched).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.isTrue(yield* runtime.isLive(request.attemptId));
        assert.isTrue(Option.isNone(yield* runtime.finished(request.attemptId)));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layer({ database: `${directory}/durable.sqlite`, parent: [answer("Done.")] }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
