import { createServer } from "node:net";
import { NodeServices } from "@effect/platform-node";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServeError } from "effect/unstable/http/HttpServerError";
import { assert, describe, it } from "vitest";
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
  refuseTakenPort,
  serverStartError,
  volatileRoot,
  volatileRoots,
} from "../src/cli.ts";

const noEnvironment = {
  port: Option.none<string>(),
  listen: Option.none<string>(),
  logLevel: Option.none<string>(),
  allowVolatileInstance: Option.none<string>(),
};

describe("usine CLI", () => {
  it("parses backup independently of server settings and provides help", async () => {
    const command = await Effect.runPromise(
      parseCli(["backup", "evidence.sqlite"], {
        ...noEnvironment,
        port: Option.some("invalid"),
      }),
    );
    assert(command._tag === "BackupCommand");
    assert.strictEqual(command.output, "evidence.sqlite");
    assert.strictEqual(
      (await Effect.runPromise(parseCli(["backup", "--help"], noEnvironment)))._tag,
      "HelpCommand",
    );
  });

  it.each([
    { args: ["backup"] },
    { args: ["backup", ""] },
    { args: ["backup", "--unknown"] },
    { args: ["backup", "copy.sqlite", "extra"] },
  ])("rejects incomplete or unsupported backup arguments: $args", async ({ args }) => {
    assert.instanceOf(
      await Effect.runPromise(parseCli(args, noEnvironment).pipe(Effect.flip)),
      CliUsageError,
    );
  });

  it.each([
    { flags: [], output: Option.none<string>() },
    { flags: ["--output", "evidence.json"], output: Option.some("evidence.json") },
    { flags: ["-o", "evidence.json"], output: Option.some("evidence.json") },
  ])(
    "parses Run export flags $flags independently of server settings",
    async ({ flags, output }) => {
      const environment = { ...noEnvironment, port: Option.some("invalid-server-port") };
      const command = await Effect.runPromise(
        parseCli(["export-run", "run/1", ...flags], environment),
      );
      assert(command._tag === "ExportRunCommand");
      assert.strictEqual(command.runId, "run/1");
      assert.deepStrictEqual(command.output, output);
    },
  );

  it("shows Run export help without requiring a Run id", async () => {
    assert.strictEqual(
      (await Effect.runPromise(parseCli(["export-run", "--help"], noEnvironment)))._tag,
      "HelpCommand",
    );
  });

  it.each([
    { args: ["export-run"] },
    { args: ["export-run", ""] },
    { args: ["export-run", "--unknown"] },
    { args: ["export-run", "run/1", "--output"] },
    { args: ["export-run", "run/1", "--output", ""] },
    { args: ["export-run", "run/1", "--port", "7331"] },
  ])("rejects incomplete or unsupported Run export arguments: $args", async ({ args }) => {
    const error = await Effect.runPromise(parseCli(args, noEnvironment).pipe(Effect.flip));
    assert.instanceOf(error, CliUsageError);
  });

  it("parses the lifecycle commands with their timeout, force, and check flags", async () => {
    const parse = (args: ReadonlyArray<string>) =>
      Effect.runPromise(parseCli(args, { ...noEnvironment, port: Option.some("invalid") }));
    const status = await parse(["status"]);
    const stop = await parse(["stop"]);
    const restart = await parse(["restart", "--timeout", "30", "--force"]);
    const upgrade = await parse(["upgrade", "0.4.0", "--check", "--timeout=5"]);
    const latest = await parse(["upgrade"]);
    const detached = await Effect.runPromise(parseCli(["up", "--detach"], noEnvironment));

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
    assert.strictEqual(Duration.toSeconds(upgrade.options.timeout), 5);
    assert(latest._tag === "UpgradeCommand");
    assert.deepStrictEqual(latest.version, Option.none());
    assert(detached._tag === "UpCommand");
    assert.isTrue(detached.detach);
    for (const command of ["status", "stop", "restart", "upgrade"]) {
      assert.strictEqual((await parse([command, "--help"]))._tag, "HelpCommand");
    }
  });

  it.each([
    { args: ["status", "--force"] },
    { args: ["stop", "--check"] },
    { args: ["stop", "extra"] },
    { args: ["restart", "--timeout"] },
    { args: ["restart", "--timeout", "0"] },
    { args: ["restart", "--timeout", "1.5"] },
    { args: ["upgrade", "0.4.0", "0.5.0"] },
    { args: ["upgrade", "--port", "7331"] },
  ])("rejects unsupported lifecycle arguments: $args", async ({ args }) => {
    assert.instanceOf(
      await Effect.runPromise(parseCli(args, noEnvironment).pipe(Effect.flip)),
      CliUsageError,
    );
  });

  it("accepts the volatile-instance override from the flag or the environment", async () => {
    const flag = await Effect.runPromise(
      parseCli(["up", "--allow-volatile-instance", "--port=8125"], noEnvironment),
    );
    const environment = await Effect.runPromise(
      parseCli(["up"], { ...noEnvironment, allowVolatileInstance: Option.some("1") }),
    );
    const plain = await Effect.runPromise(parseCli(["up"], noEnvironment));
    const unknown = await Effect.runPromise(
      parseCli(["up", "--allow-anything"], noEnvironment).pipe(Effect.flip),
    );
    assert(
      flag._tag === "UpCommand" && environment._tag === "UpCommand" && plain._tag === "UpCommand",
    );
    assert.strictEqual(flag.allowVolatileInstance, true);
    assert.strictEqual(flag.port, 8_125);
    assert.strictEqual(environment.allowVolatileInstance, true);
    assert.strictEqual(plain.allowVolatileInstance, false);
    assert(unknown instanceof CliUsageError);
  });

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

  it("parses help, version, flag ports, and the environment fallback", async () => {
    const help = await Effect.runPromise(parseCli(["--help"], noEnvironment));
    const upHelp = await Effect.runPromise(parseCli(["up", "-h"], noEnvironment));
    const version = await Effect.runPromise(parseCli(["--version"], noEnvironment));
    const flagged = await Effect.runPromise(
      parseCli(["up", "--port", "8123"], { ...noEnvironment, port: Option.some("9000") }),
    );
    const environment = await Effect.runPromise(
      parseCli(["up"], { ...noEnvironment, port: Option.some("8124") }),
    );

    assert.strictEqual(help._tag, "HelpCommand");
    assert.strictEqual(upHelp._tag, "HelpCommand");
    assert.strictEqual(version._tag, "VersionCommand");
    assert.strictEqual(flagged._tag, "UpCommand");
    assert.strictEqual(flagged._tag === "UpCommand" ? flagged.port : 0, 8_123);
    assert.strictEqual(environment._tag, "UpCommand");
    assert.strictEqual(environment._tag === "UpCommand" ? environment.port : 0, 8_124);
    assert.match(CLI_USAGE, /usine up \[--port <port>\]/);
  });

  it("rejects invalid ports at the CLI boundary", async () => {
    const flagError = await Effect.runPromise(
      parseCli(["up", "--port", "70000"], noEnvironment).pipe(Effect.flip),
    );
    const environmentError = await Effect.runPromise(
      parseCli(["up"], { ...noEnvironment, port: Option.some("not-a-port") }).pipe(Effect.flip),
    );
    assert(flagError instanceof CliUsageError);
    assert.match(flagError.message, /between 1 and 65535/);
    assert(environmentError instanceof CliUsageError);
    assert.match(environmentError.message, /^USINE_PORT/);
  });

  it("reads the log level from the flag, then the environment, ignoring case", async () => {
    const level = async (args: ReadonlyArray<string>, environment = Option.none<string>()) => {
      const command = await Effect.runPromise(
        parseCli(["up", ...args], { ...noEnvironment, logLevel: environment }),
      );
      assert(command._tag === "UpCommand");
      return command.logLevel;
    };
    assert.strictEqual(await level([]), "Info");
    assert.strictEqual(await level([], Option.some("DEBUG")), "Debug");
    assert.strictEqual(await level(["--log-level", "warn"], Option.some("debug")), "Warn");
    assert.strictEqual(await level(["--log-level=trace"]), "Trace");
    const flagError = await Effect.runPromise(
      parseCli(["up", "--log-level", "verbose"], noEnvironment).pipe(Effect.flip),
    );
    const environmentError = await Effect.runPromise(
      parseCli(["up"], { ...noEnvironment, logLevel: Option.some("") }).pipe(Effect.flip),
    );
    assert(flagError instanceof CliUsageError);
    assert.match(flagError.message, /^--log-level must be trace, debug, info, warn, or error/);
    assert(environmentError instanceof CliUsageError);
    assert.match(environmentError.message, /^USINE_LOG_LEVEL/);
  });

  it("reads the listen address from the flag, then the environment, and refuses a wildcard, loopback, or name", async () => {
    const listen = async (args: ReadonlyArray<string>, environment = Option.none<string>()) => {
      const command = await Effect.runPromise(
        parseCli(["up", ...args], { ...noEnvironment, listen: environment }),
      );
      assert(command._tag === "UpCommand");
      return command.listen;
    };
    assert.deepStrictEqual(await listen([]), Option.none());
    assert.deepStrictEqual(
      await listen([], Option.some("100.64.0.20")),
      Option.some("100.64.0.20"),
    );
    assert.deepStrictEqual(
      await listen(["--listen", "fd7a:115c:a1e0::1"], Option.some("100.64.0.20")),
      Option.some("fd7a:115c:a1e0::1"),
    );
    assert.deepStrictEqual(await listen(["--listen=100.64.0.21"]), Option.some("100.64.0.21"));
    for (const address of [
      "0.0.0.0",
      "::",
      "0:0::0",
      SERVER_HOST,
      "orchestrator",
      "100.64.0.20:7331",
    ]) {
      const error = await Effect.runPromise(
        parseCli(["up", "--listen", address], noEnvironment).pipe(Effect.flip),
      );
      assert(error instanceof CliUsageError, address);
      assert.match(error.message, /^--listen must be one IP address of this machine/u);
    }
    const environmentError = await Effect.runPromise(
      parseCli(["up"], { ...noEnvironment, listen: Option.some("0.0.0.0") }).pipe(Effect.flip),
    );
    assert(environmentError instanceof CliUsageError);
    assert.match(environmentError.message, /^USINE_LISTEN/u);
  });

  it("reads the version pinned in the installed server package", async () => {
    const version = await Effect.runPromise(
      packageVersion().pipe(Effect.provide(NodeServices.layer)),
    );
    assert.match(version, /^\d+\.\d+\.\d+(?:-.+)?$/u);
  });

  it("names an occupied port instead of leaking the low-level bind failure", () => {
    const port = Port.make(7_331);
    const bindFailure = Object.assign(new Error("listen EADDRINUSE: address already in use"), {
      code: "EADDRINUSE",
    });
    const error = serverStartError(
      SERVER_HOST,
      port,
      new ServeError({
        cause: bindFailure,
      }),
    );

    assert(error instanceof PortInUseError);
    assert.strictEqual(error.port, port);
  });

  it("refuses a port another process listens on before startup and names that process", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen({ host: SERVER_HOST, port: 0 }, resolve));
    const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Port }))(listener.address());

    const refused = await Effect.runPromise(
      refuseTakenPort(SERVER_HOST, port).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );
    assert(refused instanceof PortInUseError);
    assert.deepStrictEqual(refused.holder, Option.some(process.pid));

    await new Promise((resolve) => listener.close(resolve));
    await Effect.runPromise(
      refuseTakenPort(SERVER_HOST, port).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("bounds a browser opener that never exits and configures forced cleanup", async () => {
    let observed: ChildProcess.Command | undefined;
    const hangingSpawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        observed = command;
        return Effect.never;
      }),
    );
    const error = await Effect.runPromise(
      openBrowser("http://127.0.0.1:7331", "10 millis").pipe(
        Effect.provide(hangingSpawner),
        Effect.flip,
      ),
    );

    assert(error instanceof BrowserOpenError);
    assert(observed !== undefined && observed._tag === "StandardCommand");
    assert.strictEqual(observed.options.detached, false);
    assert.strictEqual(observed.options.forceKillAfter, "1 second");
    assert.strictEqual(observed.options.stdin, "ignore");
    assert.strictEqual(observed.options.stdout, "ignore");
    assert.strictEqual(observed.options.stderr, "ignore");
  });
});
