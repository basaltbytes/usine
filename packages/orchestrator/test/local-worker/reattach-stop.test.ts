import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { InfraFailure } from "@usine/core/attempt/failure";
import { InstanceDirectory } from "@usine/core/instance";
import { safeSegment } from "@usine/core/repository";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { stubAttemptRuntime, StubStorage, worksFor } from "@usine/durable/testing";
import { ReconcileInterval, RunEngine, Submission } from "@usine/engine/engine";
import { Context, Deferred, Effect, Exit, FileSystem, Layer, Ref, Schedule, Scope } from "effect";
import {
  LIVE_TEST_TIMEOUT,
  localRuntime,
  makeRemote,
  submission,
  waitFor,
  waitForStarted,
} from "./support.ts";

it.live(
  "keeps a read checkout when cancellation interrupts reattachment before launch and the parent cannot stop",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-reattach-stop-" });
      const instance = InstanceDirectory.make(root);
      const remote = yield* makeRemote(root);
      const storage = new StubStorage();
      const firstScope = yield* Scope.make();
      const first = Context.get(
        yield* Scope.provide(
          Layer.build(
            localRuntime(instance, remote, {
              attemptRuntime: stubAttemptRuntime(storage, worksFor(30_000)),
            }),
          ),
          firstScope,
        ),
        RunEngine,
      );
      const accepted = yield* first.submit(
        new Submission({ ...submission(1), permissions: "read" }),
      );
      assert(accepted._tag === "Claimed");
      const [attempt] = (yield* waitFor(first, accepted.runId, "Running")).attempts;
      assert(attempt !== undefined);
      yield* waitForStarted(first, attempt.id);
      const worktree = `${root}/.usine/workers/local/attempts/${safeSegment(attempt.id)}`;
      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(yield* fs.exists(worktree));

      const preparing = yield* Deferred.make<void>();
      const refusing = yield* Ref.make(true);
      const observations = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const runtime = Layer.effect(
        AttemptRuntime,
        Effect.gen(function* () {
          const original = yield* AttemptRuntime;
          return AttemptRuntime.of({
            ...original,
            cancel: (id) =>
              Effect.gen(function* () {
                yield* Ref.update(observations, (all) => [...all, true]);
                assert.isTrue(
                  yield* fs.exists(worktree).pipe(Effect.orDie),
                  "the checkout must exist until the parent stops",
                );
                if (yield* Ref.get(refusing))
                  return yield* new InfraFailure({ message: "Stop refused", cause: "offline" });
                yield* original.cancel(id);
              }),
          });
        }),
      ).pipe(Layer.provide(stubAttemptRuntime(storage)));
      const preparingFs = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (path, content, options) =>
          path.endsWith("/usine-hooks/pre-push")
            ? Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never))
            : fs.writeFileString(path, content, options),
      });
      const secondScope = yield* Scope.make();
      const second = Context.get(
        yield* Scope.provide(
          Layer.build(
            localRuntime(instance, remote, {
              attemptRuntime: runtime,
              platform: Layer.merge(NodeServices.layer, preparingFs),
            }),
          ),
          secondScope,
        ),
        RunEngine,
      );
      yield* Deferred.await(preparing);
      const failure = yield* Effect.flip(second.cancel(accepted.runId));
      assert.strictEqual(failure._tag, "AttemptCancellationError");
      assert.isTrue(yield* fs.exists(worktree));
      assert.isNotEmpty(yield* Ref.get(observations));
      yield* Ref.set(refusing, false);
      yield* Effect.repeat(fs.exists(worktree), {
        until: (exists) => !exists,
        schedule: Schedule.spaced("10 millis"),
      }).pipe(Effect.timeout("10 seconds"));
      yield* Scope.close(secondScope, Exit.void);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(ReconcileInterval, "50 millis"),
    ),
  LIVE_TEST_TIMEOUT,
);
