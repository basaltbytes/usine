import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { SshDestination } from "@usine/core/worker";
import { Effect, FileSystem, Redacted } from "effect";
import { remoteCommandsFor, sendingShell } from "../../src/remote/commands.ts";

it.live("sends variables and added keys over stdin to a server that clears the environment", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const ssh = `${directory}/ssh`;
    const argumentsLog = `${directory}/arguments`;
    // Like the boxd proxy, the server runs the line without the client's environment.
    yield* fs.writeFileString(
      ssh,
      `#!/bin/sh
printf '%s\\n' "$@" >> '${argumentsLog}'
for arg do line=$arg; done
exec env -i PATH="$PATH" HOME="$HOME" sh -c "$line"
`,
      { mode: 0o700 },
    );
    const commands = yield* remoteCommandsFor;
    const base = commands.shellFor({ command: ssh, args: [] }, SshDestination.make("fake"));
    const secret = "it's $HOME; $(exit 9)\n日本語\n\n";
    const shell = sendingShell(base, { GH_TOKEN: Redacted.make(secret) });
    assert.strictEqual(shell.sshEnvironment.GH_TOKEN, undefined);
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
    const combined = sendingShell(shell, { OPENAI_API_KEY: Redacted.make("another key") });
    const combinedValue = yield* commands.run("launch", combined, "sh", [
      "-c",
      'printf "%s|%s" "$GH_TOKEN" "$OPENAI_API_KEY"',
    ]);
    assert.strictEqual(combinedValue, `${secret}|another key`);
    const sshArguments = yield* fs.readFileString(argumentsLog);
    assert.notInclude(sshArguments, "exit 9");
    assert.notInclude(sshArguments, "another key");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
