import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { confinedDirectory } from "../../src/supervisor/confine.ts";

/** A sandbox root and a directory outside it, which no confined path may reach. */
const roots = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-confine-" });
  const outside = yield* fs.makeTempDirectoryScoped({ prefix: "usine-outside-" });
  return { fs, root, outside };
});

describe("confined supervisor directories", () => {
  it.effect("creates each missing directory below the root", () =>
    Effect.gen(function* () {
      const { fs, root } = yield* roots;
      yield* confinedDirectory(fs, root, `${root}/conversations/c1/workspace/acme/app`);
      const created = yield* fs.stat(`${root}/conversations/c1/workspace/acme/app`);
      assert.strictEqual(created.type, "Directory");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("refuses a link in a segment, and creates nothing through it", () =>
    Effect.gen(function* () {
      const { fs, root, outside } = yield* roots;
      yield* fs.makeDirectory(`${root}/conversations`);
      yield* fs.symlink(outside, `${root}/conversations/c1`);
      const refused = yield* confinedDirectory(
        fs,
        root,
        `${root}/conversations/c1/workspace/acme/app`,
      ).pipe(Effect.flip);
      assert.include(refused.message, `${root}/conversations/c1 is a SymbolicLink`);
      const written = yield* fs.readDirectory(outside);
      assert.deepStrictEqual(written, []);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("refuses a link at the leaf", () =>
    Effect.gen(function* () {
      const { fs, root, outside } = yield* roots;
      yield* fs.makeDirectory(`${root}/conversations/c1`, { recursive: true });
      yield* fs.symlink(outside, `${root}/conversations/c1/workspace`);
      const refused = yield* confinedDirectory(fs, root, `${root}/conversations/c1/workspace`).pipe(
        Effect.flip,
      );
      assert.include(refused.message, "is a SymbolicLink, not a directory");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("refuses a path with a .. segment or outside the root", () =>
    Effect.gen(function* () {
      const { fs, root, outside } = yield* roots;
      const climbing = yield* confinedDirectory(fs, root, `${root}/conversations/../..`).pipe(
        Effect.flip,
      );
      assert.include(climbing.message, "has an empty, . or .. segment");
      const elsewhere = yield* confinedDirectory(fs, root, `${outside}/workspace`).pipe(
        Effect.flip,
      );
      assert.include(elsewhere.message, "isn't below");
      const written = yield* fs.readDirectory(outside);
      assert.deepStrictEqual(written, []);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
