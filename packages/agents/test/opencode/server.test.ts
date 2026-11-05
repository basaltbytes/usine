import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import { type ChildHost, LocalProcess, RemoteShell } from "../../src/child-host/child-host.ts";
import { OpenCodeServer, openCodeServerLive } from "../../src/harness/opencode/server.ts";
import { WorkingDirectory } from "../../src/runtime.ts";

for (const placement of ["local", "ssh", "container"] as const) {
  it.live(
    `passes the server password through stdin without exposing it in ${placement} arguments`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-opencode-password-" });
        const capture = `${directory}/password`;
        yield* fs.writeFileString(
          `${directory}/opencode`,
          '#!/bin/sh\nprintf "%s\\n%s\\n" "$OPENCODE_PASSWORD" "$OPENCODE_SERVER_PASSWORD" > "$OPENCODE_TEST_CAPTURE"\nprintf "invalid-readiness\\n"\ncat > /dev/null\n',
        );
        yield* fs.chmod(`${directory}/opencode`, 0o755);
        const runtime = `${directory}/container`;
        yield* fs.writeFileString(runtime, '#!/bin/sh\nshift 3\nexec "$@"\n');
        yield* fs.chmod(runtime, 0o755);
        let host: ChildHost = LocalProcess.make();
        if (placement !== "local") {
          host = RemoteShell.make({
            ssh: {
              command: fileURLToPath(new URL("../fixtures/ssh-shim.sh", import.meta.url)),
              args: [],
            },
            sshEnvironment: { PATH: "/usr/bin:/bin" },
            destination: "worker.example",
          });
          if (placement === "container")
            host = RemoteShell.make({ ...host, container: { runtime, name: "attempt" } });
        }
        const argumentsSeen: Array<string> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          assert.strictEqual(command._tag, "StandardCommand");
          if (command._tag === "StandardCommand") argumentsSeen.push(...command.args);
          return native.spawn(command);
        });
        const server = yield* OpenCodeServer.pipe(
          Effect.provide(
            openCodeServerLive.pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)),
            ),
          ),
        );
        const error = yield* server
          .open({
            host,
            cwd: WorkingDirectory.make(directory),
            sessionId: Option.none(),
            environment: { PATH: `${directory}:/usr/bin:/bin`, OPENCODE_TEST_CAPTURE: capture },
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.message, "Invalid OpenCode readiness");
        const [password, serverPassword] = (yield* fs.readFileString(capture)).trim().split("\n");
        assert.match(password ?? "", /^[a-f0-9-]{36}$/u);
        assert.strictEqual(serverPassword, password);
        assert.notInclude(argumentsSeen.join(" "), password ?? "");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
