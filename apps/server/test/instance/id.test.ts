// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { afterEach, assert, describe, it } from "@effect/vitest";
import { InstanceIdError, instanceIdOf } from "../../src/instance/id.ts";
import { instanceFiles } from "../../src/instance/record.ts";

const folders: Array<string> = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Returns the files of a new instance folder whose `.usine` folder exists, as after the lock. */
const lockedFolderFiles = () => {
  const folder = mkdtempSync(join(tmpdir(), "usine-instance-id-"));
  folders.push(folder);
  const files = instanceFiles(folder);
  mkdirSync(files.folder);
  return files;
};

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

describe("instance ID", () => {
  // A new ID at each start would leave every earlier process's attempt containers on the workers.
  it.live("creates the ID at the first start and returns the same one at every later start", () =>
    Effect.gen(function* () {
      const files = lockedFolderFiles();

      const first = yield* Effect.promise(() =>
        run(instanceIdOf(files).pipe(Effect.provide(NodeServices.layer))),
      );
      const second = yield* Effect.promise(() =>
        run(instanceIdOf(files).pipe(Effect.provide(NodeServices.layer))),
      );

      assert.strictEqual(second, first);
      assert.strictEqual(readFileSync(files.id, "utf8"), `${first}\n`);
    }),
  );

  it.live("refuses a file without an instance ID instead of replacing it", () =>
    Effect.gen(function* () {
      const files = lockedFolderFiles();
      writeFileSync(files.id, "github-app-4242\n");

      const error = yield* Effect.promise(() =>
        run(instanceIdOf(files).pipe(Effect.flip, Effect.provide(NodeServices.layer))),
      );

      const matchesError = Schema.is(InstanceIdError)(error);
      assert(matchesError);
      assert.strictEqual(error.operation, "read");
      assert.strictEqual(error.path, files.id);
      assert.strictEqual(readFileSync(files.id, "utf8"), "github-app-4242\n");
    }),
  );
});
