import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import { CursorKey, CursorStore } from "../../src/cursor/cursor.ts";
import { type PersistenceAdapter } from "./adapter.ts";

const TestCursor = Schema.Struct({ etag: Schema.String });
const StricterCursor = Schema.Struct({ watermark: Schema.String });

export const cursorContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} CursorStore contract`, () => {
    it.live("replaces one cursor durably without exposing database rows", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const key = CursorKey.make("github:basaltbytes/usine");

        yield* Effect.gen(function* () {
          const store = yield* CursorStore;
          const snapshot = yield* store.read(key, TestCursor);
          assert(Option.isNone(snapshot));
          yield* store.write(key, TestCursor, { etag: "first" });
          yield* store.write(key, TestCursor, { etag: "second" });
        }).pipe(Effect.provide(fixture.open));

        yield* Effect.gen(function* () {
          const store = yield* CursorStore;
          const restored = yield* store.read(key, TestCursor);
          assert(Option.isSome(restored));
          assert.deepStrictEqual(restored.value, { etag: "second" });
          // A stored value that no longer decodes reads as `None` instead of failing.
          const snapshot = yield* store.read(key, StricterCursor);
          assert(Option.isNone(snapshot));
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
  });
};
