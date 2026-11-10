import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ExecShell, HostUnreachable } from "@usine/agents/child-host";
import { SshDestination } from "@usine/core/worker";
import { Effect, FileSystem, Redacted, Schema, Stream } from "effect";
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
    assert(shell._tag === "RemoteShell");
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

const encoder = new TextEncoder();

it.live("fails with HostUnreachable when an SSH client exits 255, without the secret", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const ssh = `${directory}/ssh`;
    // Like OpenSSH that loses the connection, after the command echoed its stdin to stderr.
    yield* fs.writeFileString(
      ssh,
      `#!/bin/sh
cat >&2
echo 'Connection to fake closed by remote host.' >&2
exit 255
`,
      { mode: 0o700 },
    );
    const commands = yield* remoteCommandsFor;
    const shell = commands.shellFor({ command: ssh, args: [] }, SshDestination.make("fake"));
    const inspected = yield* commands.inspect("launch", shell, "true", []).pipe(Effect.flip);
    assert(Schema.is(HostUnreachable)(inspected.cause));
    assert.strictEqual(inspected.cause.destination, "fake");
    assert.strictEqual(inspected.cause.message, "Connection to fake closed by remote host.");
    assert.strictEqual(
      inspected.message,
      "Can't reach fake to run true: Connection to fake closed by remote host.",
    );
    const sent = yield* commands
      .runWithInput("launch", shell, "sh", [], Redacted.make("the secret"))
      .pipe(Effect.flip);
    assert(Schema.is(HostUnreachable)(sent.cause));
    assert.notInclude(sent.message, "the secret");
    assert.include(sent.cause.message, "[REDACTED]");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails with HostUnreachable when an exec transport loses the command", () =>
  Effect.gen(function* () {
    const lost = HostUnreachable.make({ destination: "vm-1", message: "UNAVAILABLE: reset" });
    const commands = yield* remoteCommandsFor;
    const shell = ExecShell.make({
      destination: "vm-1",
      transport: {
        run: () =>
          Effect.succeed({
            stdout: Stream.make(encoder.encode("partial")),
            stderr: Stream.empty,
            exitCode: Effect.fail(lost),
          }),
      },
    });
    const failures = yield* Effect.all([
      commands.inspect("prepare", shell, "true", []).pipe(Effect.flip),
      commands.run("prepare", shell, "true", []).pipe(Effect.flip),
    ]);
    for (const failed of failures) {
      assert.strictEqual(failed.operation, "prepare");
      assert.strictEqual(failed.cause, lost);
      assert.strictEqual(failed.message, "Can't reach vm-1 to run true: UNAVAILABLE: reset");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a command's own exit 255 on an exec transport as a result", () =>
  Effect.gen(function* () {
    const commands = yield* remoteCommandsFor;
    const shell = ExecShell.make({
      destination: "vm-1",
      transport: {
        run: () =>
          Effect.succeed({
            stdout: Stream.empty,
            stderr: Stream.make(encoder.encode("exited on purpose\n")),
            exitCode: Effect.succeed(255),
          }),
      },
    });
    const inspected = yield* commands.inspect("prepare", shell, "sh", ["-c", "exit 255"]);
    assert.deepStrictEqual(inspected, { exitCode: 255, stdout: "", stderr: "exited on purpose\n" });
  }).pipe(Effect.provide(NodeServices.layer)),
);
