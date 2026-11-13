import { HttpServerError } from "effect/http";
import { createServer } from "node:net";
import { NodeServices } from "@effect/platform-node";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { assert, describe, it } from "@effect/vitest";
import {
  CLI_USAGE,
  BrowserOpenError,
  CliUsageError,
  Port,
  PortInUseError,
  SERVER_HOST,
  packageVersion,
  openBrowser,
  parseCli,
  serverStartError,
  volatileRoot,
  volatileRoots,
} from "../src/cli.ts";
import { listenForStartup } from "../src/listener.ts";

const noEnvironment = {
  port: Option.none<string>(),
  origin: Option.none<string>(),
  logLevel: Option.none<string>(),
  allowVolatileInstance: Option.none<string>(),
};

describe("usine CLI", () => {
  it.effect("parses usine mcp for the local instance and for a remote origin", () =>
    Effect.gen(function* () {
      const local = yield* parseCli(["mcp"], noEnvironment);
      assert(local._tag === "McpCommand");
      assert.isTrue(Option.isNone(local.origin));
      const remote = yield* parseCli(["mcp", "--origin", "https://usine.example/"], noEnvironment);
      assert(remote._tag === "McpCommand");
      assert.deepEqual(remote.origin, Option.some("https://usine.example"));
      const inline = yield* parseCli(["mcp", "--origin=https://usine.example"], noEnvironment);
      assert(inline._tag === "McpCommand");
      assert.deepEqual(inline.origin, Option.some("https://usine.example"));
      for (const args of [
        ["mcp", "--origin"],
        ["mcp", "extra"],
        ["mcp", "--origin", "ftp://x"],
      ])
        assert.equal(
          (yield* parseCli(args, noEnvironment).pipe(Effect.flip))._tag,
          "CliUsageError",
          args.join(" "),
        );
      assert.include(CLI_USAGE, "usine mcp [--origin <url>]");
    }),
  );
  it.live("parses provider login and logout independently of server settings", () =>
    Effect.gen(function* () {
      const login = yield* parseCli(
        ["login", "chatgpt", "--api-key", "--target", "gateway"],
        noEnvironment,
      );
      assert(login._tag === "ProviderCommand");
      assert.equal(login.mode, "api-key");
      assert.deepEqual(login.target, Option.some("gateway"));
      const logout = yield* parseCli(["logout", "claude"], noEnvironment);
      assert(logout._tag === "ProviderCommand");
      assert.equal(logout.action, "logout");
      assert.equal(logout.provider, "claude");
    }),
  );
  it.live.each([
    ["login"],
    ["login", "unknown"],
    ["logout", "claude", "--api-key"],
    ["login", "claude", "--target"],
    ["login", "claude", "--target", ""],
    ["login", "claude", "--target", "--api-key"],
  ])("rejects invalid provider arguments: %j", (args) =>
    Effect.gen(function* () {
      const error = yield* parseCli(args, noEnvironment).pipe(Effect.flip);
      assert.instanceOf(error, CliUsageError);
    }),
  );

  it.live.each([
    ["config"],
    ["config", "export", ""],
    ["config", "import", ""],
    ["config", "import", "folder", "--message"],
    ["config", "edit", "unknown", "name"],
    ["config", "log", "agent"],
  ])("rejects malformed configuration operands: %j", (args) =>
    Effect.gen(function* () {
      const failure = yield* parseCli(args, noEnvironment).pipe(Effect.flip);
      assert.instanceOf(failure, CliUsageError);
    }),
  );

  it.live("parses backup independently of server settings and provides help", () =>
    Effect.gen(function* () {
      const command = yield* parseCli(["backup", "evidence.sqlite"], {
        ...noEnvironment,
        port: Option.some("invalid"),
      });
      assert(command._tag === "BackupCommand");
      assert.strictEqual(command.output, "evidence.sqlite");
      assert.strictEqual(
        (yield* parseCli(["backup", "--help"], noEnvironment))._tag,
        "HelpCommand",
      );
    }),
  );

  it.live.each([
    { args: ["backup"] },
    { args: ["backup", ""] },
    { args: ["backup", "--unknown"] },
    { args: ["backup", "copy.sqlite", "extra"] },
  ])("rejects incomplete or unsupported backup arguments: $args", ({ args }) =>
    Effect.gen(function* () {
      const actual1 = yield* parseCli(args, noEnvironment).pipe(Effect.flip);
      assert.instanceOf(actual1, CliUsageError);
    }),
  );

  it.live.each([
    { flags: [], output: Option.none<string>() },
    { flags: ["--output", "evidence.json"], output: Option.some("evidence.json") },
    { flags: ["-o", "evidence.json"], output: Option.some("evidence.json") },
  ])("parses Run export flags $flags independently of server settings", ({ flags, output }) =>
    Effect.gen(function* () {
      const environment = { ...noEnvironment, port: Option.some("invalid-server-port") };
      const command = yield* parseCli(["export-run", "run/1", ...flags], environment);
      assert(command._tag === "ExportRunCommand");
      assert.strictEqual(command.runId, "run/1");
      assert.deepStrictEqual(command.output, output);
    }),
  );

  it.live("shows Run export help without requiring a Run id", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* parseCli(["export-run", "--help"], noEnvironment))._tag,
        "HelpCommand",
      );
    }),
  );

  it.live.each([
    { args: ["export-run"] },
    { args: ["export-run", ""] },
    { args: ["export-run", "--unknown"] },
    { args: ["export-run", "run/1", "--output"] },
    { args: ["export-run", "run/1", "--output", ""] },
    { args: ["export-run", "run/1", "--port", "7331"] },
  ])("rejects incomplete or unsupported Run export arguments: $args", ({ args }) =>
    Effect.gen(function* () {
      const error = yield* parseCli(args, noEnvironment).pipe(Effect.flip);
      assert.instanceOf(error, CliUsageError);
    }),
  );

  it.live("parses the lifecycle commands with their timeout, force, and check flags", () =>
    Effect.gen(function* () {
      const parse = (args: ReadonlyArray<string>) =>
        parseCli(args, { ...noEnvironment, port: Option.some("invalid") });
      const status = yield* parse(["status"]);
      const stop = yield* parse(["stop"]);
      const restart = yield* parse(["restart", "--timeout", "30", "--force"]);
      const upgrade = yield* parse(["upgrade", "0.4.0", "--check", "--timeout=5"]);
      const latest = yield* parse(["upgrade"]);
      const detached = yield* parseCli(["up", "--detach"], noEnvironment);

      assert.strictEqual(status._tag, "StatusCommand");
      assert(stop._tag === "StopCommand");
      assert.strictEqual(Duration.toSeconds(stop.options.timeout), 120);
      assert.isFalse(stop.options.force);
      assert(restart._tag === "RestartCommand");
      assert.strictEqual(Duration.toSeconds(restart.options.timeout), 30);
      assert.isTrue(restart.options.force);
      assert(upgrade._tag === "UpgradeCommand");
      assert.deepStrictEqual(upgrade.version, Option.some("0.4.0"));
      assert.isTrue(upgrade.check);
      const next = yield* parse(["upgrade", "--channel", "next"]);
      assert(next._tag === "UpgradeCommand");
      assert.deepStrictEqual(next.version, Option.some("next"));
      assert.strictEqual(Duration.toSeconds(upgrade.options.timeout), 5);
      assert(latest._tag === "UpgradeCommand");
      assert.deepStrictEqual(latest.version, Option.none());
      assert(detached._tag === "UpCommand");
      assert.isTrue(detached.detach);
      for (const command of ["status", "stop", "restart", "upgrade"]) {
        assert.strictEqual((yield* parse([command, "--help"]))._tag, "HelpCommand");
      }
    }),
  );

  it.live.each([
    { args: ["status", "--force"] },
    { args: ["stop", "--check"] },
    { args: ["stop", "extra"] },
    { args: ["restart", "--timeout"] },
    { args: ["restart", "--timeout", "0"] },
    { args: ["restart", "--timeout", "1.5"] },
    { args: ["upgrade", "0.4.0", "0.5.0"] },
    { args: ["upgrade", "--port", "7331"] },
  ])("rejects unsupported lifecycle arguments: $args", ({ args }) =>
    Effect.gen(function* () {
      const actual2 = yield* parseCli(args, noEnvironment).pipe(Effect.flip);
      assert.instanceOf(actual2, CliUsageError);
    }),
  );

  it.live("accepts the volatile-instance override from the flag or the environment", () =>
    Effect.gen(function* () {
      const flag = yield* parseCli(
        ["up", "--allow-volatile-instance", "--port=8125"],
        noEnvironment,
      );
      const environment = yield* parseCli(["up"], {
        ...noEnvironment,
        allowVolatileInstance: Option.some("1"),
      });
      const plain = yield* parseCli(["up"], noEnvironment);
      const unknown = yield* parseCli(["up", "--allow-anything"], noEnvironment).pipe(Effect.flip);
      assert(
        flag._tag === "UpCommand" && environment._tag === "UpCommand" && plain._tag === "UpCommand",
      );
      assert.strictEqual(flag.allowVolatileInstance, true);
      assert.strictEqual(flag.port, 8_125);
      assert.strictEqual(environment.allowVolatileInstance, true);
      assert.strictEqual(plain.allowVolatileInstance, false);
      const matchesUnknown = Schema.is(CliUsageError)(unknown);
      assert(matchesUnknown);
    }),
  );

  it("recognises instance folders under temp roots and leaves others alone", () => {
    const roots = volatileRoots(Option.some("/var/folders/ab/T"));
    assert(roots.includes("/tmp"));
    assert(roots.includes("/private/tmp"));
    assert(roots.includes("/var/folders/ab/T"));
    assert.deepStrictEqual(
      volatileRoot("/private/tmp/usine-factory", roots),
      Option.some("/private/tmp"),
    );
    assert(Option.isSome(volatileRoot("/var/folders/ab/T/x/y", roots)));
    assert.deepStrictEqual(volatileRoot("/tmp", roots), Option.some("/tmp"));
    assert.deepStrictEqual(volatileRoot("/tmpfiles/usine", roots), Option.none());
    assert.deepStrictEqual(volatileRoot("/Users/me/Code/usine-factory", roots), Option.none());
  });

  it.live("parses help, version, flag ports, and the environment fallback", () =>
    Effect.gen(function* () {
      const help = yield* parseCli(["--help"], noEnvironment);
      const upHelp = yield* parseCli(["up", "-h"], noEnvironment);
      const version = yield* parseCli(["--version"], noEnvironment);
      const flagged = yield* parseCli(["up", "--port", "8123"], {
        ...noEnvironment,
        port: Option.some("9000"),
      });
      const environment = yield* parseCli(["up"], { ...noEnvironment, port: Option.some("8124") });

      assert.strictEqual(help._tag, "HelpCommand");
      assert.strictEqual(upHelp._tag, "HelpCommand");
      assert.strictEqual(version._tag, "VersionCommand");
      assert.strictEqual(flagged._tag, "UpCommand");
      assert.strictEqual(flagged._tag === "UpCommand" ? flagged.port : 0, 8_123);
      assert.strictEqual(environment._tag, "UpCommand");
      assert.strictEqual(environment._tag === "UpCommand" ? environment.port : 0, 8_124);
      assert.match(CLI_USAGE, /usine up \[--port <port>\]/);
    }),
  );

  it.live("rejects invalid ports at the CLI boundary", () =>
    Effect.gen(function* () {
      const flagError = yield* parseCli(["up", "--port", "70000"], noEnvironment).pipe(Effect.flip);
      const environmentError = yield* parseCli(["up"], {
        ...noEnvironment,
        port: Option.some("not-a-port"),
      }).pipe(Effect.flip);
      const matchesFlagError = Schema.is(CliUsageError)(flagError);
      assert(matchesFlagError);
      assert.match(flagError.message, /between 1 and 65535/);
      const matchesEnvironmentError = Schema.is(CliUsageError)(environmentError);
      assert(matchesEnvironmentError);
      assert.match(environmentError.message, /^USINE_PORT/);
    }),
  );

  it.live("reads the log level from the flag, then the environment, ignoring case", () =>
    Effect.gen(function* () {
      const level = (args: ReadonlyArray<string>, environment = Option.none<string>()) =>
        Effect.gen(function* () {
          const command = yield* parseCli(["up", ...args], {
            ...noEnvironment,
            logLevel: environment,
          });
          assert(command._tag === "UpCommand");
          return command.logLevel;
        });
      const actual3 = yield* level([]);
      assert.strictEqual(actual3, "Info");
      const actual4 = yield* level([], Option.some("DEBUG"));
      assert.strictEqual(actual4, "Debug");
      const actual5 = yield* level(["--log-level", "warn"], Option.some("debug"));
      assert.strictEqual(actual5, "Warn");
      const actual6 = yield* level(["--log-level=trace"]);
      assert.strictEqual(actual6, "Trace");
      const flagError = yield* parseCli(["up", "--log-level", "verbose"], noEnvironment).pipe(
        Effect.flip,
      );
      const environmentError = yield* parseCli(["up"], {
        ...noEnvironment,
        logLevel: Option.some(""),
      }).pipe(Effect.flip);
      const matchesFlagError = Schema.is(CliUsageError)(flagError);
      assert(matchesFlagError);
      assert.match(flagError.message, /^--log-level must be trace, debug, info, warn, or error/);
      const matchesEnvironmentError = Schema.is(CliUsageError)(environmentError);
      assert(matchesEnvironmentError);
      assert.match(environmentError.message, /^USINE_LOG_LEVEL/);
    }),
  );

  it.live(
    "reads the UI origin from the flag, then the environment, and refuses a URL with a path or another scheme",
    () =>
      Effect.gen(function* () {
        const origin = (args: ReadonlyArray<string>, environment = Option.none<string>()) =>
          Effect.gen(function* () {
            const command = yield* parseCli(["up", ...args], {
              ...noEnvironment,
              origin: environment,
            });
            assert(command._tag === "UpCommand");
            return command.origin;
          });
        const serve = "https://usine-orchestrator.tail1234.ts.net";
        const actual7 = yield* origin([]);
        assert.deepStrictEqual(actual7, Option.none());
        const actual8 = yield* origin([], Option.some(serve));
        assert.deepStrictEqual(actual8, Option.some(serve));
        // As a browser writes it in the Origin header: no slash, no default port, and lower case.
        const actual9 = yield* origin(
          ["--origin", "https://Usine-Orchestrator.tail1234.ts.net:443/"],
          Option.some("https://other.tail1234.ts.net"),
        );
        assert.deepStrictEqual(actual9, Option.some(serve));
        const actual10 = yield* origin(["--origin=http://127.0.0.1:8080"]);
        assert.deepStrictEqual(actual10, Option.some("http://127.0.0.1:8080"));
        for (const value of [
          "usine-orchestrator.tail1234.ts.net",
          `${serve}/ui`,
          `${serve}/?tab=runs`,
          "https://operator@usine-orchestrator.tail1234.ts.net",
          "ftp://usine-orchestrator.tail1234.ts.net",
          "file:///home/usine",
          "http://100.64.0.20:8080",
        ]) {
          const error = yield* parseCli(["up", "--origin", value], noEnvironment).pipe(Effect.flip);
          assert(Schema.is(CliUsageError)(error), value);
          assert.match(error.message, /^--origin must be the http or https URL of the UI/u);
        }
        const environmentError = yield* parseCli(["up"], {
          ...noEnvironment,
          origin: Option.some(`${serve}/ui`),
        }).pipe(Effect.flip);
        const matchesEnvironmentError = Schema.is(CliUsageError)(environmentError);
        assert(matchesEnvironmentError);
        assert.match(environmentError.message, /^USINE_ORIGIN/u);
      }),
  );

  it.live("reads the version pinned in the installed server package", () =>
    Effect.gen(function* () {
      const version = yield* packageVersion().pipe(Effect.provide(NodeServices.layer));
      assert.match(version, /^\d+\.\d+\.\d+(?:-.+)?$/u);
    }),
  );

  it("names an occupied port instead of leaking the low-level bind failure", () => {
    const port = Port.make(7_331);
    const bindFailure = Object.assign(new Error("listen EADDRINUSE: address already in use"), {
      code: "EADDRINUSE",
    });
    const error = serverStartError(
      port,
      new HttpServerError.ServeError({
        cause: bindFailure,
      }),
    );

    const matchesError = Schema.is(PortInUseError)(error);
    assert(matchesError);
    assert.strictEqual(error.port, port);
  });

  it.live("refuses a port another process listens on and names that process", () =>
    Effect.gen(function* () {
      const listener = createServer();
      yield* Effect.callback<void>((resume) => {
        const resolve = (value: void) => resume(Effect.succeed(value));
        listener.listen({ host: SERVER_HOST, port: 0 }, resolve);
      });
      const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Port }))(
        listener.address(),
      );

      const refused = yield* listenForStartup(port, "test").pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
      const matchesRefused = Schema.is(PortInUseError)(refused);
      assert(matchesRefused);
      assert.deepStrictEqual(refused.holder, Option.some(process.pid));

      yield* Effect.callback<void>((resume) => {
        const resolve = () => resume(Effect.void);
        listener.close(resolve);
      });
      yield* listenForStartup(port, "test").pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    }),
  );

  it.live("bounds a browser opener that never exits and configures forced cleanup", () =>
    Effect.gen(function* () {
      let observed: ChildProcess.Command | undefined;
      const hangingSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          observed = command;
          return Effect.never;
        }),
      );
      const error = yield* openBrowser("http://127.0.0.1:7331", "10 millis").pipe(
        Effect.provide(hangingSpawner),
        Effect.flip,
      );

      const matchesError = Schema.is(BrowserOpenError)(error);
      assert(matchesError);
      assert(observed !== undefined && observed._tag === "StandardCommand");
      assert.strictEqual(observed.options.detached, false);
      assert.strictEqual(observed.options.forceKillAfter, "1 second");
      assert.strictEqual(observed.options.stdin, "ignore");
      assert.strictEqual(observed.options.stdout, "ignore");
      assert.strictEqual(observed.options.stderr, "ignore");
    }),
  );
});
