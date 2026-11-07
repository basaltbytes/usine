import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { outputAcknowledgements } from "../../src/child-host/output.ts";

describe("output acknowledgements", () => {
  it.effect("checkpoints inside a stdout frame until all of its bytes are handled", () =>
    Effect.gen(function* () {
      const output = yield* outputAcknowledgements();
      yield* output.record({ remaining: 18, handled: 0, start: 0, offset: 36 });
      yield* output.record({ remaining: 4, handled: 0, start: 36, offset: 50 });
      const cursors = yield* Effect.forEach([11, 5, 4, 2], (bytes) =>
        output.acknowledge(bytes).pipe(Effect.andThen(output.cursor)),
      );
      assert.deepStrictEqual(cursors, [
        { offset: 0, skip: 11 },
        { offset: 0, skip: 16 },
        { offset: 36, skip: 2 },
        { offset: 50, skip: 0 },
      ]);
    }),
  );

  it.effect("counts the bytes a resumed relay skipped in the first replayed frame", () =>
    Effect.gen(function* () {
      const output = yield* outputAcknowledgements();
      yield* output.reset({ offset: 0, skip: 3 });
      yield* output.record({ remaining: 7, handled: 3, start: 0, offset: 20 });
      const cursors = yield* Effect.forEach([0, 2], (bytes) =>
        output.acknowledge(bytes).pipe(Effect.andThen(output.cursor)),
      );
      assert.deepStrictEqual(cursors, [
        { offset: 0, skip: 3 },
        { offset: 0, skip: 5 },
      ]);
    }),
  );
});
