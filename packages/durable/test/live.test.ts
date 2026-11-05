import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "@effect/vitest";

it.live.each(["node", "custom", "environment", "unknown-parent"])(
  "opens the live harness with one proxy-aware dispatcher (%s fetch/environment)",
  (scenario) =>
    Effect.gen(function* () {
      const directory = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeTempDirectory({
          directory: dirname(join(tmpdir(), "usine-http-dispatcher-")),
          prefix: basename(join(tmpdir(), "usine-http-dispatcher-")),
        }),
      );
      try {
        yield* Effect.promise(() =>
          promisify(execFile)(
            process.execPath,
            [
              "--experimental-strip-types",
              fileURLToPath(new URL("./fixtures/http-dispatcher.ts", import.meta.url)),
              directory,
              scenario,
            ],
            {
              timeout: 20_000,
              env: {
                ...process.env,
                PI_CODING_AGENT_DIR: join(directory, "pi"),
                PI_OFFLINE: "1",
                HTTP_PROXY: undefined,
                HTTPS_PROXY: undefined,
                http_proxy: undefined,
                https_proxy: undefined,
                NO_PROXY: "127.0.0.1",
                no_proxy: "127.0.0.1",
              },
            },
          ),
        );
      } finally {
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(directory, { recursive: true, force: true }),
        );
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  30_000,
);
