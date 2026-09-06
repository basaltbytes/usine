import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServeError } from "effect/unstable/http/HttpServerError";
import { assert, describe, it } from "vitest";
import {
  CLI_USAGE,
  BrowserOpenError,
  CliUsageError,
  Port,
  PortInUseError,
  packageVersion,
  openBrowser,
  parseCli,
  serverStartError,
  volatileRoot,
  volatileRoots,
} from "../src/cli.ts";

const noEnvironment = { port: Option.none<string>(), allowVolatileInstance: Option.none<string>() };

describe("usine CLI", () => {
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
      port,
      new ServeError({
        cause: bindFailure,
      }),
    );

    assert(error instanceof PortInUseError);
    assert.strictEqual(error.port, port);
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
