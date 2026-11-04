import { assert, describe, it } from "@effect/vitest";
import { LoopName } from "@usine/core/loop";
import { Effect } from "effect";

import { LoopControl } from "../../src/loop-control/loop-control.ts";
import { type PersistenceAdapter } from "./adapter.ts";

export const loopControlContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} LoopControl contract`, () => {
    it.live("persists pause without changing authored Loop files", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const loop = LoopName.make("review");

        yield* Effect.gen(function* () {
          const control = yield* LoopControl;
          assert.strictEqual(yield* control.isPaused(loop), false);
          assert.strictEqual((yield* control.pause(loop)).paused, true);
          assert.strictEqual((yield* control.pause(loop)).paused, true);
        }).pipe(Effect.provide(fixture.open));

        yield* Effect.gen(function* () {
          const control = yield* LoopControl;
          assert.strictEqual(yield* control.isPaused(loop), true);
          assert.deepStrictEqual(
            (yield* control.states).map((state) => [state.loop, state.paused]),
            [[loop, true]],
          );
          assert.strictEqual((yield* control.unpause(loop)).paused, false);
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
  });
};
