import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import { type Brand, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { fileHomesLayer } from "../../src/supervisor/homes/file.ts";
import { ConversationHomes } from "../../src/supervisor/homes/homes.ts";
import { memoryHomesLayer } from "../../src/supervisor/homes/memory.ts";
import { conversationKey } from "../../src/supervisor/names.ts";

class Broken extends Schema.TaggedError<Broken, Brand.Brand<"test/Broken">>()("Broken", {}) {}

const key = conversationKey(AgentSessionId.make("supervisor:c1"));
const encoder = new TextEncoder();
const archive = (text: string) => Stream.make(encoder.encode(text));

const loaded = (homes: ConversationHomes["Service"]) =>
  homes.load(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (stream) => stream.pipe(Stream.decodeText(), Stream.mkString, Effect.asSome),
      }),
    ),
  );

const adapters = {
  file: Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      return fileHomesLayer(`${directory}/homes`);
    }),
  ),
  memory: memoryHomesLayer,
};

for (const [name, layer] of Object.entries(adapters))
  describe(`saved homes in ${name}`, () => {
    it.effect("returns what the last save wrote, and nothing before the first save", () =>
      Effect.gen(function* () {
        const homes = yield* ConversationHomes;
        const before = yield* loaded(homes);
        assert.deepStrictEqual(before, Option.none());
        yield* homes.save(key, archive("first"));
        yield* homes.save(key, Stream.concat(archive("sec"), archive("ond")));
        const after = yield* loaded(homes);
        assert.deepStrictEqual(after, Option.some("second"));
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    );

    it.effect("keeps the saved home when an archive fails before its end", () =>
      Effect.gen(function* () {
        const homes = yield* ConversationHomes;
        yield* homes.save(key, archive("good"));
        const failure = yield* homes
          .save(key, Stream.concat(archive("partial"), Stream.fail(Broken.make({}))))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Broken");
        const kept = yield* loaded(homes);
        assert.deepStrictEqual(kept, Option.some("good"));
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    );
  });

it.effect("ignores a partial save that a crash left, and replaces it on the next save", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${directory}/${key}.tar.partial`, "torn");
    yield* Effect.gen(function* () {
      const homes = yield* ConversationHomes;
      const before = yield* loaded(homes);
      assert.deepStrictEqual(before, Option.none());
      yield* homes.save(key, archive("whole"));
      const after = yield* loaded(homes);
      assert.deepStrictEqual(after, Option.some("whole"));
    }).pipe(Effect.provide(fileHomesLayer(directory)));
    const files = yield* fs.readDirectory(directory);
    assert.deepStrictEqual(files, [`${key}.tar`]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
