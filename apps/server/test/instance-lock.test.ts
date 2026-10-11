import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { Effect, Exit, Option, Scope } from "effect";
import { afterEach, assert, describe, it } from "vitest";
import { holdInstance, InstanceInUseError, InstanceLockError } from "../src/instance-lock.ts";

const folders: Array<string> = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const instanceFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "usine-lock-"));
  folders.push(folder);
  return InstanceDirectory.make(folder);
};

describe("instance lock", () => {
  it("refuses a second holder, names the first one's pid, and frees the folder on release", async () => {
    const directory = instanceFolder();
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Scope.make();
        yield* holdInstance(directory).pipe(Scope.provide(first));
        assert.strictEqual(
          readFileSync(join(directory, ".usine", "instance.pid"), "utf8").trim(),
          String(process.pid),
        );
        const refused = yield* holdInstance(directory).pipe(Effect.scoped, Effect.flip);
        assert(refused instanceof InstanceInUseError);
        assert.deepStrictEqual(refused.holder, Option.some(process.pid));
        yield* Scope.close(first, Exit.void);
        yield* holdInstance(directory).pipe(Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("reports a folder it cannot lock apart from one another process holds", async () => {
    const directory = instanceFolder();
    writeFileSync(join(directory, ".usine"), "not a folder");
    const refused = await Effect.runPromise(
      holdInstance(directory).pipe(Effect.scoped, Effect.flip, Effect.provide(NodeServices.layer)),
    );
    assert(refused instanceof InstanceLockError);
  });
});
