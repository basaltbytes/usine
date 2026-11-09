import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { SshDestination, WorkerName } from "@usine/core/worker";
import { Effect, FileSystem, Redacted } from "effect";
import { remoteCommandsFor } from "../../src/remote/commands.ts";

for (const acceptsSendEnv of [true, false]) {
  it.live(
    `round-trips initial variables and added keys when SSH accepts SendEnv: ${acceptsSendEnv}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const ssh = `${directory}/ssh`;
        yield* fs.writeFileString(
          ssh,
          `#!/bin/sh
for arg do line=$arg; done
unset OPENAI_API_KEY
exec ${acceptsSendEnv ? "" : 'env -i PATH="$PATH" HOME="$HOME" '}sh -c "$line"
`,
          { mode: 0o700 },
        );
        const commands = yield* remoteCommandsFor;
        const worker = WorkerName.make("stdin-test");
        const base = commands.shellFor({ command: ssh, args: [] }, SshDestination.make("fake"));
        const secret = "it's $HOME; $(exit 9)\n日本語\n\n";
        const shell = yield* commands.sendingShell(
          worker,
          base,
          { GH_TOKEN: Redacted.make(secret) },
          "probe",
        );
        assert.strictEqual(shell.stdinEnvironment === undefined, acceptsSendEnv);
        const input = "command input\nsecond line\n";
        const result = yield* commands.runWithInput(
          "launch",
          shell,
          "sh",
          ["-c", 'printf "%s" "$GH_TOKEN"; cat'],
          Redacted.make(input),
        );
        assert.strictEqual(result, `${secret}[REDACTED]`);
        const inspected = yield* commands.inspect("launch", shell, "sh", [
          "-c",
          'printf "%s" "$GH_TOKEN"; echo diagnostic >&2; exit 7',
        ]);
        assert.strictEqual(inspected.exitCode, 7);
        assert.strictEqual(inspected.stdout, secret);
        assert.strictEqual(inspected.stderr, "diagnostic\n");
        const combined = yield* commands.sendingShell(worker, shell, {
          OPENAI_API_KEY: Redacted.make("another key"),
        });
        assert(combined.stdinEnvironment !== undefined);
        assert.strictEqual(combined.sshEnvironment.GH_TOKEN, undefined);
        const combinedValue = yield* commands.run("launch", combined, "sh", [
          "-c",
          'printf "%s|%s" "$GH_TOKEN" "$OPENAI_API_KEY"',
        ]);
        assert.strictEqual(combinedValue, `${secret}|another key`);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
