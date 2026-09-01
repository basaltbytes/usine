import { NodeServices } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { ServeError } from "effect/unstable/http/HttpServerError";
import { assert, describe, it } from "vitest";
import {
  CLI_USAGE,
  CliUsageError,
  Port,
  PortInUseError,
  packageVersion,
  parseCli,
  serverStartError,
} from "../src/cli.ts";

describe("usine CLI", () => {
  it("parses help, version, flag ports, and the environment fallback", async () => {
    const help = await Effect.runPromise(parseCli(["--help"], Option.none()));
    const upHelp = await Effect.runPromise(parseCli(["up", "-h"], Option.none()));
    const version = await Effect.runPromise(parseCli(["--version"], Option.none()));
    const flagged = await Effect.runPromise(
      parseCli(["up", "--port", "8123"], Option.some("9000")),
    );
    const environment = await Effect.runPromise(parseCli(["up"], Option.some("8124")));

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
      parseCli(["up", "--port", "70000"], Option.none()).pipe(Effect.flip),
    );
    const environmentError = await Effect.runPromise(
      parseCli(["up"], Option.some("not-a-port")).pipe(Effect.flip),
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
});
