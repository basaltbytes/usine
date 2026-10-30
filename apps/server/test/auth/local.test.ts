import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Option, Redacted } from "effect";
import { assert, it } from "vitest";
import { readAdminToken, writeAdminToken } from "../../src/auth/local.ts";

it("reads an owned admin token and rejects a different or unknown owner", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "usine-admin-owner-" }),
      );
      yield* fs.makeDirectory(`${directory}/.usine`);
      const token = yield* writeAdminToken(directory);
      assert.equal(Redacted.value(yield* readAdminToken(directory)), Redacted.value(token));
      for (const uid of [Option.some((process.getuid?.() ?? 0) + 1), Option.none<number>()]) {
        const error = yield* readAdminToken(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            lstat: (path) => fs.lstat(path).pipe(Effect.map((info) => ({ ...info, uid }))),
          }),
          Effect.flip,
        );
        assert.equal(error.status, 503);
        assert.include(error.message, `${directory}/.usine/admin-token`);
        assert.include(error.message, `uid ${process.getuid?.()}`);
        assert.include(error.message, "0600");
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  ));
