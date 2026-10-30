import { assert, it } from "@effect/vitest";
import { ReleaseVersion } from "@usine/core/upgrade";
import { RunId } from "@usine/core/run";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { RunEngineShutdown } from "../src/engine/shutdown.ts";
import { AttemptAdmission } from "../src/engine/admission.ts";

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
            admission.withAttempt(RunId.make("startup-recovery"), Effect.void, () => Effect.void),
            { startImmediately: true },
          );
          // Admission is synchronous, so an admitted Attempt would have completed this fiber; a
          // denied one waits interruptibly for teardown.
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

it.effect(
  "draining interrupts a pending reservation and releases a slot acquired before admission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const admission = yield* AttemptAdmission;
        const reserved = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const attempt = yield* Ref.make(false);
        yield* Effect.forkScoped(
          admission.withAttempt(
            RunId.make("reserved"),
            Effect.acquireRelease(Deferred.succeed(reserved, undefined), () =>
              Deferred.succeed(released, undefined),
            ).pipe(Effect.andThen(Effect.never)),
            () => Ref.set(attempt, true),
          ),
        );
        yield* Deferred.await(reserved);
        yield* admission.waitForUpgrade(ReleaseVersion.make("1.2.3"));
        yield* Deferred.await(released);
        assert.strictEqual(yield* Ref.get(attempt), false);
        yield* admission.drain();
        yield* admission.cancelUpgrade;
        const denied = yield* Effect.forkScoped(
          admission.withAttempt(RunId.make("after-cancel"), Effect.void, () =>
            Ref.set(attempt, true),
          ),
          { startImmediately: true },
        );
        assert.strictEqual(denied.pollUnsafe(), undefined);
        assert.strictEqual(yield* Ref.get(attempt), false);
      }),
    ).pipe(Effect.provide(AttemptAdmission.layer)),
);
