import { assert, it } from "@effect/vitest";
import { RunId } from "@usine/core/run";
import { Deferred, Effect, Fiber } from "effect";
import { RunEngineShutdown } from "../src/engine/shutdown.ts";
import { AttemptAdmission } from "../src/workflow/admission.ts";

it.effect(
  "a host latch denies admission before any drain call and denied work remains cancelable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shutdown = yield* Deferred.make<void>();
        yield* Deferred.succeed(shutdown, undefined);
        yield* Effect.gen(function* () {
          const admission = yield* AttemptAdmission;
          const denied = yield* Effect.forkScoped(
            admission.withAttempt(RunId.make("startup-recovery"), Effect.void),
            { startImmediately: true },
          );
          // Admission is synchronous. Successful admission would already have
          // completed this fiber; a denied Attempt waits interruptibly for teardown.
          assert.strictEqual(denied.pollUnsafe(), undefined);
          yield* Fiber.interrupt(denied);
          yield* admission.drain();
        }).pipe(
          Effect.provide(AttemptAdmission.layer),
          Effect.provideService(RunEngineShutdown, shutdown),
        );
      }),
    ),
);
