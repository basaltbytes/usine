import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { Effect, Exit, Fiber, Option, Scope } from "effect";
import { attachmentFor } from "../src/coordinator/attachment.ts";

const attemptId = AttemptId.make("coordinator/attachment");

/** Holds `attachment` for a call in a new scope, and returns the call and its scope. */
const held = (attachment: Effect.Success<ReturnType<typeof attachmentFor>>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const call = yield* attachment.hold.pipe(Scope.provide(scope));
    return { call, scope };
  });

describe("Attachment", () => {
  it.live("holds the Attempt for a second call only after the first detaches", () =>
    Effect.gen(function* () {
      const attachment = yield* attachmentFor(attemptId);
      const first = yield* held(attachment);
      const second = yield* Effect.forkChild(held(attachment), { startImmediately: true });
      const early = yield* Fiber.join(second).pipe(Effect.timeoutOption("100 millis"));
      const idleWhileWaiting = yield* attachment.isIdle;
      yield* Scope.close(first.scope, Exit.void);
      const later = yield* Fiber.join(second);
      yield* Scope.close(later.scope, Exit.void);
      const idleAfter = yield* attachment.isIdle;

      assert.isTrue(Option.isNone(early));
      assert.isFalse(idleWhileWaiting);
      assert.notStrictEqual(later.call, first.call);
      assert.isTrue(idleAfter);
    }),
  );

  it.live("is idle again after a waiting call is interrupted", () =>
    Effect.gen(function* () {
      const attachment = yield* attachmentFor(attemptId);
      const first = yield* held(attachment);
      const second = yield* Effect.forkChild(held(attachment), { startImmediately: true });
      yield* Fiber.interrupt(second);
      yield* Scope.close(first.scope, Exit.void);
      const idle = yield* attachment.isIdle;

      assert.isTrue(idle);
    }),
  );

  it.effect("keeps the first ending of a call", () =>
    Effect.gen(function* () {
      const attachment = yield* attachmentFor(attemptId);
      const before = yield* attachment.end("canceled");
      const { call, scope } = yield* held(attachment);
      const failed = yield* attachment.end("sink failed");
      const canceled = yield* attachment.end("canceled");
      const ending = yield* attachment.ending;
      yield* Scope.close(scope, Exit.void);
      const afterDetach = yield* attachment.ending;

      assert.isTrue(Option.isNone(before));
      assert.deepStrictEqual(failed, Option.some(call));
      assert.deepStrictEqual(canceled, Option.some(call));
      assert.deepStrictEqual(ending, Option.some("sink failed"));
      assert.deepStrictEqual(afterDetach, Option.none());
    }),
  );

  it.live("reports a call detached once another call holds the Attempt", () =>
    Effect.gen(function* () {
      const attachment = yield* attachmentFor(attemptId);
      const first = yield* held(attachment);
      yield* Scope.close(first.scope, Exit.void);
      const second = yield* held(attachment);
      const detached = yield* attachment
        .detached(first.call)
        .pipe(Effect.timeoutOption("1 second"));
      const current = yield* attachment
        .detached(second.call)
        .pipe(Effect.timeoutOption("100 millis"));
      yield* Scope.close(second.scope, Exit.void);

      assert.isTrue(Option.isSome(detached));
      assert.isTrue(Option.isNone(current));
    }),
  );
});
