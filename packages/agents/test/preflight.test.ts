import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { HarnessReady, HarnessUnavailableError } from "@usine/core/agent/capability";
import { Deferred, Effect, Fiber, Layer, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { TestClock } from "effect/testing";
import { CodexAppServer, type CodexConnection } from "../src/pi/codex/app-server.ts";
import { PiSdk, type PiStartResult } from "../src/pi/sdk.ts";
import { CODEX_CLI_VERSION, verifyHarness } from "../src/preflight/preflight.ts";
import packageJson from "../package.json" with { type: "json" };

const brain = (harness: BrainSpec["harness"]) =>
  new BrainSpec({ harness, model: ModelId.make("provider/model"), effort: "low" });
const coder = brain("codex");
const encoder = new TextEncoder();

const commands = (
  responses: Readonly<Record<string, { readonly stdout: string; readonly exitCode: number }>>,
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert.strictEqual(command._tag, "StandardCommand");
        if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
        const key = [command.command, ...command.args].join(" ");
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

const account = (response: Effect.Effect<Schema.Json>) => {
  let opened = 0;
  let closed = 0;
  const layer = Layer.succeed(CodexAppServer)({
    open: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          opened += 1;
          return {
            notifications: Stream.empty,
            notify: (_operation, method) =>
              Effect.sync(() => assert.strictEqual(method, "initialized")),
            request: (_operation, method) => {
              if (method === "initialize") return Effect.succeed({});
              assert.strictEqual(method, "account/read", "preflight must not start agent work");
              return response;
            },
          } satisfies CodexConnection;
        }),
        () =>
          Effect.sync(() => {
            closed += 1;
          }),
      ),
  });
  return { layer, opened: () => opened, closed: () => closed };
};
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
      const server = account(Effect.succeed(null));
      return Effect.gen(function* () {
        const error = yield* verifyHarness(coder).pipe(Effect.flip);
        assert(error instanceof HarnessUnavailableError);
        assert.strictEqual(error.capability, result.capability);
        assert.strictEqual(server.opened(), 0);
        assert(!JSON.stringify(error).includes("credential-shaped"));
      }).pipe(
        Effect.provide(commands({ "codex --version": result })),
        Effect.provide(server.layer),
        Effect.provide(unusedPi),
      );
    });
  }

  for (const auth of [{ type: "apiKey" }, { type: "chatgpt" }]) {
    it.effect(
      `checks Codex ${auth.type} authentication and closes its unprompted connection`,
      () => {
        const server = account(Effect.succeed({ account: auth, requiresOpenaiAuth: true }));
        return Effect.gen(function* () {
          if (auth.type === "chatgpt") {
            assert.deepStrictEqual(
              yield* verifyHarness(coder),
              new HarnessReady({ harness: "codex" }),
            );
          } else {
            const error = yield* verifyHarness(coder).pipe(Effect.flip);
            assert(error instanceof HarnessUnavailableError);
            assert.strictEqual(error.capability, "login");
          }
          assert.strictEqual(server.opened(), 1);
          assert.strictEqual(server.closed(), 1);
        }).pipe(
          Effect.provide(
            commands({
              "codex --version": { stdout: `codex-cli ${CODEX_CLI_VERSION}`, exitCode: 0 },
            }),
          ),
          Effect.provide(server.layer),
          Effect.provide(unusedPi),
        );
      },
    );
  }

  it.effect("closes a stalled account probe without declaring the login unavailable", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const server = account(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const pending = yield* verifyHarness(coder).pipe(
        Effect.flip,
        Effect.provide(
          commands({
            "codex --version": { stdout: `codex-cli ${CODEX_CLI_VERSION}`, exitCode: 0 },
          }),
        ),
        Effect.provide(server.layer),
        Effect.provide(unusedPi),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual((yield* Fiber.join(pending))._tag, "SessionOperationError");
      assert.strictEqual(server.closed(), 1);
    }),
  );

  for (const auth of [
    { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" },
  ]) {
    it.effect(`checks Claude ${auth.authMethod} login without probing Codex or Pi`, () => {
      const server = account(Effect.succeed(null));
      return Effect.gen(function* () {
        if (auth.authMethod === "claude.ai") {
          assert.deepStrictEqual(
            yield* verifyHarness(brain("claude")),
            new HarnessReady({ harness: "claude" }),
          );
        } else {
          const error = yield* verifyHarness(brain("claude")).pipe(Effect.flip);
          assert(error instanceof HarnessUnavailableError);
          assert.strictEqual(error.capability, "login");
        }
        assert.strictEqual(server.opened(), 0);
      }).pipe(
        Effect.provide(
          commands({
            "claude --version": { stdout: "2.1.263 (Claude Code)", exitCode: 0 },
            "claude auth status --json": {
              stdout: JSON.stringify(auth),
              exitCode: auth.loggedIn ? 0 : 1,
            },
          }),
        ),
        Effect.provide(server.layer),
        Effect.provide(unusedPi),
      );
    });
  }

  for (const pool of ["apiKeys", "chatgptPlan"] as const) {
    it.effect(`checks Pi ${pool} authentication and disposes its unprompted SDK session`, () => {
      let disposed = 0;
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
            disposed += 1;
          },
        },
      };
      return Effect.gen(function* () {
        if (pool === "apiKeys") {
          assert.deepStrictEqual(
            yield* verifyHarness(brain("pi")),
            new HarnessReady({ harness: "pi" }),
          );
        } else {
          const error = yield* verifyHarness(brain("pi")).pipe(Effect.flip);
          assert(error instanceof HarnessUnavailableError);
          assert.strictEqual(error.capability, "login");
        }
        assert.strictEqual(disposed, 1);
      }).pipe(
        Effect.provide(commands({})),
        Effect.provide(account(Effect.succeed(null)).layer),
        Effect.provide(Layer.succeed(PiSdk)({ start: async () => started })),
      );
    });
  }
});
