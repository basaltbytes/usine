import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { Effect, Layer, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CodexAppServer } from "../src/pi/codex/app-server.ts";
import { PiSdk, type PiStartResult } from "../src/pi/sdk.ts";
import { CODEX_CLI_VERSION, verifyHarness } from "../src/preflight/preflight.ts";
import packageJson from "../package.json" with { type: "json" };

const brain = (harness: BrainSpec["harness"]) =>
  new BrainSpec({ harness, model: ModelId.make("provider/model"), effort: "low" });
const coder = brain("codex");
const encoder = new TextEncoder();

const commands = (
  responses: Readonly<Record<string, { readonly stdout: string; readonly exitCode: number }>>,
  seen: Array<string>,
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert.strictEqual(command._tag, "StandardCommand");
        if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
        const key = [command.command, ...command.args].join(" ");
        seen.push(key);
        const response = responses[key];
        assert(response !== undefined, `unexpected command ${key}`);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(response.stdout)),
          stderr: Stream.make(encoder.encode("credential-shaped diagnostic must not escape")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

const account = (response: Schema.Json, seen: Array<string>) =>
  Layer.succeed(CodexAppServer)({
    open: () =>
      Effect.succeed({
        notifications: Stream.empty,
        notify: () => Effect.void,
        request: (_operation, method) =>
          Effect.sync(() => {
            seen.push(method);
            return method === "account/read" ? response : {};
          }),
      }),
  });
const unusedPi = Layer.succeed(PiSdk)({
  start: async () => {
    throw new Error("Pi must not start for another harness");
  },
});

describe("worker harness readiness", () => {
  it("checks the same Codex version as the protocol conformance gate", () => {
    assert.strictEqual(
      CODEX_CLI_VERSION,
      packageJson.devDependencies["@pwrdrvr/codex-app-server-protocol"],
    );
  });

  for (const result of [
    { stdout: "", exitCode: 127, capability: "binary" },
    { stdout: "codex-cli 0.153.4", exitCode: 0, capability: "version" },
  ]) {
    it.effect(`refuses a Codex ${result.capability} gap before any account request`, () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const error = yield* verifyHarness(coder).pipe(Effect.flip);
        assert(error instanceof HarnessUnavailableError);
        assert.strictEqual(error.capability, result.capability);
        assert(!seen.includes("account/read"));
        assert(!JSON.stringify(error).includes("credential-shaped"));
      }).pipe(
        Effect.provide(commands({ "codex --version": result }, seen)),
        Effect.provide(account(null, seen)),
        Effect.provide(unusedPi),
      );
    });
  }

  for (const auth of [null, { type: "apiKey" }, { type: "chatgpt" }]) {
    it.effect(`checks Codex ${auth?.type ?? "logged-out"} authentication without a turn`, () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const result = yield* verifyHarness(coder).pipe(Effect.result);
        assert.strictEqual(result._tag, auth?.type === "chatgpt" ? "Success" : "Failure");
        assert.deepStrictEqual(seen, ["codex --version", "initialize", "account/read"]);
      }).pipe(
        Effect.provide(
          commands(
            { "codex --version": { stdout: `codex-cli ${CODEX_CLI_VERSION}`, exitCode: 0 } },
            seen,
          ),
        ),
        Effect.provide(account({ account: auth, requiresOpenaiAuth: true }, seen)),
        Effect.provide(unusedPi),
      );
    });
  }

  for (const auth of [
    { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" },
  ]) {
    it.effect(`checks Claude ${auth.authMethod} login without probing Codex or Pi`, () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const result = yield* verifyHarness(brain("claude")).pipe(Effect.result);
        assert.strictEqual(result._tag, auth.authMethod === "claude.ai" ? "Success" : "Failure");
        assert.deepStrictEqual(seen, ["claude --version", "claude auth status --json"]);
      }).pipe(
        Effect.provide(
          commands(
            {
              "claude --version": { stdout: "2.1.263 (Claude Code)", exitCode: 0 },
              "claude auth status --json": {
                stdout: JSON.stringify(auth),
                exitCode: auth.loggedIn ? 0 : 1,
              },
            },
            seen,
          ),
        ),
        Effect.provide(account(null, seen)),
        Effect.provide(unusedPi),
      );
    });
  }

  for (const pool of ["apiKeys", "chatgptPlan"] as const) {
    it.effect(`checks Pi ${pool} authentication and disposes its unprompted SDK session`, () => {
      let disposed = false;
      const started: PiStartResult = {
        _tag: "Started",
        model: ModelId.make("provider/model"),
        pool,
        session: {
          messages: [],
          subscribe: () => () => {},
          prompt: async () => {
            throw new Error("preflight must never prompt");
          },
          steer: async () => {},
          abort: async () => {},
          dispose: () => {
            disposed = true;
          },
        },
      };
      return Effect.gen(function* () {
        const result = yield* verifyHarness(brain("pi")).pipe(Effect.result);
        assert.strictEqual(result._tag, pool === "apiKeys" ? "Success" : "Failure");
        assert(disposed);
      }).pipe(
        Effect.provide(commands({}, [])),
        Effect.provide(account(null, [])),
        Effect.provide(Layer.succeed(PiSdk)({ start: async () => started })),
      );
    });
  }
});
