import { createServer } from "node:http";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { checkoutFiles } from "../src/checkout-files.ts";
import { collectCommand, requireSuccess } from "../src/child-command.ts";

it.live(
  "preserves successful HTTP protocol output after installing and reinstalling diagnostics",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const files = checkoutFiles((operation, command, args) =>
        collectCommand(spawner, operation, command, args, {}).pipe(
          Effect.flatMap((result) => requireSuccess(operation, "local", command, args, result)),
        ),
      );
      const trace = `${root}/trace.jsonl`;
      yield* files.installGitDiagnostics(trace);
      yield* files.installGitDiagnostics(trace);
      const commit = "a".repeat(40);
      const packet = (value: string) => (value.length + 4).toString(16).padStart(4, "0") + value;
      const server = yield* NodeHttpServer.make(
        () =>
          createServer((_request, response) => {
            response.writeHead(200, {
              "content-type": "application/x-git-upload-pack-advertisement",
            });
            response.end(
              packet("# service=git-upload-pack\n") +
                "0000" +
                packet(`${commit} refs/heads/main\0\n`) +
                "0000",
            );
          }),
        { host: "127.0.0.1", port: 0 },
      );
      assert(server.address._tag !== "UnixPathAddress");
      const result = yield* collectCommand(
        spawner,
        "prepare",
        "git",
        ["-c", "protocol.version=0", "ls-remote", `http://127.0.0.1:${server.address.port}/repo`],
        {
          cwd: root,
          env: { GIT_TRACE2_EVENT: trace, GIT_EXEC_PATH: `${trace}.helpers` },
        },
      );
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout, `${commit}\trefs/heads/main\n`);
      assert.strictEqual(result.stderr, "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
