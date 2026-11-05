import { jsonKey } from "@usine/core/json-key";
// SDK streams and hooks require native Promises, including the test implementations.
// @effect-diagnostics newPromise:off
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type ExtensionToolContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { AgentName } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession, sessionPool } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { Effect, Fiber, Layer, Logger, Option, Queue, Stream, Schema } from "effect";
import {
  AgentResultError,
  AgentCapacityError,
  ChildRequest,
  ChildBackend,
  ChildSessionLifecycle,
  PoolUnavailableError,
  SessionOperationError,
  toAttemptFailure,
  UnknownModelError,
  WorkingDirectory,
  type OnDelivery,
} from "../../src/runtime.ts";
import { LocalProcess, RemoteShell } from "../../src/child-host/child-host.ts";
import { piChildLayer } from "../../src/harness/pi/pi.ts";
import {
  environmentBashTool,
  piChildTools,
  PiSdk,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
  type PiStartResult,
} from "../../src/harness/pi/sdk.ts";
import { resolvePiPool } from "../../src/harness/pi/authentication.ts";

const noDelivery: OnDelivery = () => Effect.void;
const childTools = ["read", "bash", "edit", "write"];

/** Runs `env` with `bash` and returns the names of the variables it prints. */
const environmentNames = (bash: ToolDefinition) =>
  Effect.promise(() =>
    bash.execute(
      "call-1",
      { command: "env" },
      undefined,
      undefined,
      // SAFETY: without session variables the bash tool reads only the optional `cwd` of its context.
      {} as ExtensionToolContext,
    ),
  ).pipe(
    Effect.map((result) =>
      result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .split("\n")
        .flatMap((line) => (line.includes("=") ? [line.slice(0, line.indexOf("="))] : [])),
    ),
  );

/** Keeps the names that are neither in `expected` nor set by the shell for every command. */
const notShellSet = (expected: ReadonlyArray<string>) => (name: string) =>
  ![...expected, "PWD", "OLDPWD", "SHLVL", "_"].includes(name);

describe("Pi pool resolution", () => {
  it("maps ChatGPT subscription authentication to the ChatGPT pool", () => {
    assert.strictEqual(
      resolvePiPool("openai-codex", { _tag: "OAuth", subscription: true }),
      "chatgptPlan",
    );
  });

  it("keeps API-key authentication in the API-key pool", () => {
    assert.strictEqual(resolvePiPool("openai", { _tag: "ApiKey" }), "apiKeys");
  });

  it("rejects missing and unsupported OAuth credentials instead of inventing an API key", () => {
    assert.strictEqual(resolvePiPool("openai-codex", undefined), undefined);
    assert.strictEqual(
      resolvePiPool("github-copilot", { _tag: "OAuth", subscription: true }),
      undefined,
    );
    assert.strictEqual(
      resolvePiPool("openai-codex", { _tag: "OAuth", subscription: false }),
      undefined,
    );
  });
});

const delayedPiStart = () => {
  let resolveStart: ((result: PiStartResult) => void) | undefined;
  let announceStart: (() => void) | undefined;
  let announceDispose: (() => void) | undefined;
  let disposeCount = 0;
  const startCalled = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  const disposed = new Promise<void>((resolve) => {
    announceDispose = resolve;
  });
  const session: PiSession = {
    abort: () => Promise.resolve(),
    dispose: () => {
      disposeCount += 1;
      announceDispose?.();
    },
    messages: [],
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    subscribe: () => () => undefined,
  };
  return {
    disposeCount: () => disposeCount,
    disposed,
    resolve: (
      result: Omit<
        Extract<PiStartResult, { readonly _tag: "Started" }>,
        "session" | "tools" | "harnessSession"
      >,
    ) => {
      assert(resolveStart !== undefined);
      resolveStart({ ...result, harnessSession: Option.none(), session, tools: childTools });
    },
    start: () => {
      announceStart?.();
      return new Promise<PiStartResult>((resolve) => {
        resolveStart = resolve;
      });
    },
    startCalled,
  };
};

describe("Pi child backend", () => {
  const childRequest = ChildRequest.make({
    worker: WorkerName.make("worker-1"),
    machine: Option.none(),
    environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
    host: LocalProcess.make(),
    session: ChildSession.make({
      id: AgentSessionId.make("pi-child-1"),
      parentId: AgentSessionId.make("parent-1"),
      agent: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("pi"),
        model: ModelId.make("openai/gpt-5.6-terra"),
        effort: "medium",
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/usine"),
    prompt: "Implement the focused task.",
  });

  it.live("suppresses a Pi prompt failure when its attempt is stopping", () => {
    let stopping = false;
    let rejectPrompt: ((cause: unknown) => void) | undefined;
    const logs: Array<{ level: string; message: string }> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      logs.push({ level: logLevel.toUpperCase(), message: jsonKey(message) });
    });
    const session: PiSession = {
      abort: () => Promise.resolve(),
      dispose: () => {},
      messages: [],
      prompt: () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
      steer: () => Promise.resolve(),
      subscribe: () => () => {},
    };
    const sdk = Layer.succeed(PiSdk)({
      start: () =>
        Promise.resolve({
          _tag: "Started",
          harnessSession: Option.none(),
          model: childRequest.session.brain.model,
          pool: "apiKeys",
          session,
          tools: childTools,
        }),
    });
    return Effect.gen(function* () {
      yield* (yield* ChildBackend).launch(childRequest);
      while (rejectPrompt === undefined) yield* Effect.sleep("10 millis");
      stopping = true;
      rejectPrompt(new Error("Session disposed during shutdown"));
      while (!logs.some(({ message }) => message.includes("stopped with its attempt")))
        yield* Effect.sleep("10 millis");
      assert.deepStrictEqual(
        logs.filter(({ level }) => level === "WARN" || level === "ERROR"),
        [],
      );
    }).pipe(
      Effect.provide(piChildLayer.pipe(Layer.provide(sdk))),
      Effect.provideService(ChildSessionLifecycle, { isStopping: Effect.sync(() => stopping) }),
      Effect.provide(Logger.layer([logger])),
      Effect.timeout("5 seconds"),
      Effect.scoped,
    );
  });

  it.effect("keeps a held Pi child open across idle turns and returns only after release", () =>
    Effect.gen(function* () {
      const turns = yield* Queue.make<{ readonly text: string; readonly complete: () => void }>();
      const idle = yield* Queue.make<void>();
      const context = yield* Effect.context<never>();
      const fork = Effect.runForkWith(context);
      let opens = 0;
      const sdk = Layer.succeed(PiSdk)({
        start: () => {
          opens += 1;
          return Promise.resolve({
            _tag: "Started",
            harnessSession: Option.none(),
            model: childRequest.session.brain.model,
            pool: "apiKeys",
            tools: childTools,
            session: {
              messages: [],
              dispose: () => {},
              abort: () => Promise.resolve(),
              subscribe: () => () => {},
              steer: () => Promise.resolve(),
              prompt: (text) =>
                new Promise<void>((complete) => {
                  fork(Queue.offer(turns, { text, complete }));
                }),
            },
          });
        },
      });
      yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(childRequest);
        const result = yield* Effect.forkScoped(running.result);
        yield* Effect.forkScoped(
          running.events.pipe(
            Stream.runForEach((event) =>
              event._tag === "SessionIdle" ? Queue.offer(idle, undefined) : Effect.void,
            ),
          ),
        );
        const first = yield* Queue.take(turns);
        const state = yield* running.intervene(
          AttemptChannel.OperatorMessage.make({ message: "Wait for my review" }),
          noDelivery,
        );
        assert.strictEqual(state.held, true);
        first.complete();
        yield* Queue.take(idle);
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* running.intervene(
          AttemptChannel.OperatorMessage.make({ message: "Now fix the edge case" }),
          noDelivery,
        );
        const second = yield* Queue.take(turns);
        assert.strictEqual(second.text, "Now fix the edge case");
        second.complete();
        yield* Queue.take(idle);
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* running.intervene(AttemptChannel.Release.make(), noDelivery);
        assert.strictEqual((yield* Fiber.join(result)).message, "Pi session completed");
        assert.strictEqual(opens, 1);
      }).pipe(Effect.provide(piChildLayer.pipe(Layer.provideMerge(sdk))));
    }).pipe(Effect.scoped),
  );

  it.effect("reports a message to a working Pi child read once Pi starts it in the turn", () =>
    Effect.gen(function* () {
      const listeners: Array<(event: PiSessionEvent) => void> = [];
      const steered: Array<string> = [];
      const sdk = Layer.succeed(PiSdk)({
        start: () =>
          Promise.resolve({
            _tag: "Started",
            harnessSession: Option.none(),
            model: childRequest.session.brain.model,
            pool: "apiKeys",
            tools: childTools,
            session: {
              messages: [],
              dispose: () => {},
              abort: () => Promise.resolve(),
              subscribe: (listener) => {
                listeners.push(listener);
                return () => {};
              },
              steer: (text) => {
                steered.push(text);
                return Promise.resolve("queued" as const);
              },
              prompt: () => new Promise<void>(() => {}),
            },
          }),
      });
      yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(childRequest);
        const reads: Array<Option.Option<AttemptChannel.InterventionState>> = [];
        const state = yield* running.intervene(
          AttemptChannel.OperatorMessage.make({ message: "Use pnpm, not npm." }),
          (delivered) =>
            Effect.sync(() => {
              reads.push(delivered);
            }),
        );
        assert.deepStrictEqual([state.held, state.queued], [true, true]);
        assert.deepStrictEqual(steered, ["Use pnpm, not npm."]);
        assert.deepStrictEqual(reads, []);
        for (const listener of listeners)
          listener({
            type: "message_start",
            message: {
              role: "user",
              content: [{ type: "text", text: "Use pnpm, not npm." }],
              timestamp: 0,
            },
          });
        for (let spin = 0; reads.length === 0; spin += 1) {
          if (spin > 1_000) return assert.fail("the read was never reported");
          yield* Effect.yieldNow;
        }
        const [read] = reads;
        assert(read !== undefined && Option.isSome(read));
        assert.deepStrictEqual([read.value.held, read.value.queued], [true, false]);
      }).pipe(Effect.provide(piChildLayer.pipe(Layer.provideMerge(sdk))));
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { pool: "apiKeys", model: "openai/gpt-5.6-terra-2026-08-01" },
    { pool: "chatgptPlan", model: "openai-codex/gpt-5.6-sol" },
    { pool: "apiKeys", model: "openai-codex/gpt-5.6-sol" },
    { pool: "apiKeys", model: "ollama/qwen3" },
  ] as const)("normalizes $pool events and controls", ({ pool, model }) => {
    let options: PiStartOptions | undefined;
    const listeners: Array<(event: PiSessionEvent) => void> = [];
    const publish = (event: PiSessionEvent) => {
      for (const listener of listeners) listener(event);
    };
    let prompt = "";
    let steer = "";
    let interrupted = false;
    const session: PiSession = {
      abort: () => {
        interrupted = true;
        return Promise.resolve();
      },
      dispose: () => undefined,
      messages: [],
      prompt: (value) => {
        prompt = value;
        // SDK events with no normalized form are logged and skipped; they must not enter the queue
        // or stop the bridge.
        publish({ type: "compaction_start", reason: "threshold" });
        publish({
          type: "message_end",
          message: {
            ...fauxAssistantMessage("Pi child done."),
            usage: {
              input: 10,
              output: 5,
              cacheRead: 20,
              cacheWrite: 2,
              totalTokens: 37,
              cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
            },
          },
        });
        return Promise.resolve();
      },
      steer: (value) => {
        steer = value;
        return Promise.resolve();
      },
      subscribe: (found) => {
        listeners.push(found);
        return () => undefined;
      },
    };
    const effectiveModel = ModelId.make(model);
    const sdk = Layer.succeed(PiSdk)({
      start: (found) => {
        options = found;
        return Promise.resolve({
          _tag: "Started",
          harnessSession: Option.none(),
          model: effectiveModel,
          pool,
          session,
          tools: childTools,
        });
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const running = yield* backend.launch(childRequest);
        yield* running.steer("Check the test output.");
        yield* running.interrupt;
        const [events, result] = yield* Effect.all([
          Stream.runCollect(running.events),
          running.result,
        ]);
        assert.strictEqual(result.message, "Pi child done.");
        assert.strictEqual(running.session.brain.model, effectiveModel);
        assert.strictEqual(sessionPool(running.session), pool);
        assert.deepStrictEqual(running.session.pool, Option.some(pool));
        assert.deepStrictEqual(
          running.session.endpoint,
          pool === "apiKeys" ? Option.some(model.split("/")[0]) : Option.none(),
        );
        const usage = events.find((event) => event._tag === "SessionTokensUpdated");
        assert(usage?._tag === "SessionTokensUpdated");
        assert.strictEqual(sessionPool(usage.session), pool);
        assert.strictEqual(usage.totalTokens, 17);
        assert.deepStrictEqual(usage.costUsd, Option.some(0.03));
        assert.strictEqual(prompt, childRequest.prompt);
        assert.strictEqual(steer, "Check the test output.");
        assert.strictEqual(interrupted, true);
        assert.deepStrictEqual(
          options?.extensions.map(({ name }) => name),
          ["usine-session-intervention"],
        );
        assert.strictEqual(options?.model, childRequest.session.brain.model);
        assert.deepStrictEqual(options?.environment, Option.some(childRequest.environment));
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["SessionStarted", "SessionTokensUpdated", "TextOutput", "SessionFinished"],
        );
      }).pipe(Effect.provide(piChildLayer.pipe(Layer.provideMerge(sdk)))),
    );
  });

  it.effect("reports each provider retry of a turn and the recovery when Pi gets an answer", () => {
    const listeners: Array<(event: PiSessionEvent) => void> = [];
    const publish = (event: PiSessionEvent) => {
      for (const listener of listeners) listener(event);
    };
    const retry = (attempt: number, errorMessage: string): PiSessionEvent => ({
      type: "auto_retry_start",
      attempt,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage,
    });
    const session: PiSession = {
      abort: () => Promise.resolve(),
      dispose: () => undefined,
      messages: [],
      prompt: () => {
        publish(retry(1, "terminated"));
        publish(retry(2, "429 Too Many Requests"));
        publish({ type: "message_end", message: fauxAssistantMessage("Pi child done.") });
        publish({ type: "auto_retry_end", success: true, attempt: 2 });
        publish({ type: "agent_settled", aborted: false });
        // Retry numbering restarts at 1 on the next turn; a retry that Pi abandons has no recovery.
        publish(retry(1, "terminated"));
        publish({ type: "auto_retry_end", success: false, attempt: 1, finalError: "terminated" });
        publish({ type: "agent_settled", aborted: false });
        return Promise.resolve();
      },
      steer: () => Promise.resolve(),
      subscribe: (found) => {
        listeners.push(found);
        return () => undefined;
      },
    };
    const sdk = Layer.succeed(PiSdk)({
      start: () =>
        Promise.resolve({
          _tag: "Started",
          harnessSession: Option.none(),
          model: childRequest.session.brain.model,
          pool: "apiKeys",
          session,
          tools: childTools,
        }),
    });
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(jsonKey(message));
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(childRequest);
        const [events] = yield* Effect.all([Stream.runCollect(running.events), running.result]);
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          [
            "SessionStarted",
            "ProviderRetrying",
            "ProviderRetrying",
            "SessionTokensUpdated",
            "TextOutput",
            "ProviderRecovered",
            "ProviderRetrying",
            "SessionFinished",
          ],
        );
        assert.deepStrictEqual(
          events.flatMap((event) =>
            event._tag === "ProviderRetrying" ? [[event.message, event.retries]] : [],
          ),
          [
            ["terminated", 1],
            ["429 Too Many Requests", 2],
            ["terminated", 1],
          ],
        );
        const recovered = events.find((event) => event._tag === "ProviderRecovered");
        assert(recovered?._tag === "ProviderRecovered");
        assert.strictEqual(recovered.retries, 2);
        const retries = warnings.filter((line) => line.includes("cannot reach its provider"));
        assert.lengthOf(retries, 3, "one warning per provider retry");
      }).pipe(
        Effect.provide(
          piChildLayer.pipe(Layer.provideMerge(sdk), Layer.provideMerge(Logger.layer([logger]))),
        ),
      ),
    );
  });

  it.effect("refuses a remote host before starting the Pi SDK", () => {
    let started = false;
    const sdk = Layer.succeed(PiSdk)({
      start: () => {
        started = true;
        return Promise.resolve({ _tag: "UnknownModel" });
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          (yield* ChildBackend).launch(
            ChildRequest.make({
              ...childRequest,
              host: RemoteShell.make({
                ssh: { command: "ssh", args: [] },
                sshEnvironment: {},
                destination: "worker.exe.xyz",
              }),
            }),
          ),
        );
        const matchesError = Schema.is(AgentResultError)(error);
        assert(matchesError);
        assert.include(error.message, "pi cannot run as coding-agent at ssh: lacks ssh");
        assert.strictEqual(toAttemptFailure(error)._tag, "AgentFailure");
        assert.strictEqual(started, false);
      }).pipe(Effect.provide(piChildLayer.pipe(Layer.provideMerge(sdk)))),
    );
  });

  it.effect("surfaces an unknown configured child model as a typed failure", () => {
    const sdk = Layer.succeed(PiSdk)({
      start: () => Promise.resolve({ _tag: "UnknownModel" }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const error = yield* Effect.flip(backend.launch(childRequest));
        const matchesError = Schema.is(UnknownModelError)(error);
        assert(matchesError);
        assert.strictEqual(error.harness, "pi");
      }).pipe(Effect.provide(piChildLayer.pipe(Layer.provideMerge(sdk)))),
    );
  });

  for (const [started, pool] of [
    [
      { _tag: "AuthenticationUnavailable", model: ModelId.make("openai-codex/gpt-5.6-sol") },
      "chatgptPlan",
    ],
    [{ _tag: "AuthenticationUnavailable", model: ModelId.make("openai/gpt-5.6-sol") }, "apiKeys"],
    [
      {
        _tag: "UnsupportedAuthentication",
        model: ModelId.make("github-copilot/gpt-5.6-sol"),
        authentication: { _tag: "OAuth", subscription: true },
      },
      "apiKeys",
    ],
  ] as const) {
    it.effect(`rejects ${started.model} with ${started._tag}`, () => {
      const sdk = Layer.succeed(PiSdk)({
        start: () => Promise.resolve(started),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* ChildBackend;
          const error = yield* Effect.flip(backend.launch(childRequest));
          const matchesError = Schema.is(PoolUnavailableError)(error);
          assert(matchesError);
          assert.strictEqual(error.pool, pool);
          assert.strictEqual(error.model, started.model);
        }).pipe(Effect.provide(piChildLayer.pipe(Layer.provideMerge(sdk)))),
      );
    });
  }

  it.effect("runs a child's bash commands with exactly its environment and nothing inherited", () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "usine-pi-bash-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
      );
      const names = yield* environmentNames(
        environmentBashTool(directory, { PATH: "/usr/bin:/bin", USINE_ONLY: "yes" }),
      );
      assert(names.includes("USINE_ONLY"));
      assert.deepStrictEqual(names.filter(notShellSet(["PATH", "USINE_ONLY"])), []);
    }).pipe(Effect.scoped),
  );

  it.effect("gives a child Pi's default tools whatever the global defaultTools setting adds", () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "usine-pi-tools-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
      );
      // The SDK test deliberately changes the host environment to verify tool isolation.
      // @effect-diagnostics-next-line processEnvInEffect:off
      process.env.USINE_ORCHESTRATOR_ONLY = "yes";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // The SDK test deliberately changes the host environment to verify tool isolation.
          // @effect-diagnostics-next-line processEnvInEffect:off
          delete process.env.USINE_ORCHESTRATOR_ONLY;
        }),
      );
      const start = (tools: Pick<CreateAgentSessionOptions, "customTools" | "tools">) =>
        Effect.acquireRelease(
          Effect.promise(() =>
            createAgentSession({
              ...tools,
              agentDir: directory,
              cwd: directory,
              sessionManager: SessionManager.inMemory(directory),
              settingsManager: SettingsManager.inMemory({
                defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
              }),
            }),
          ),
          ({ session }) => Effect.sync(() => session.dispose()),
        ).pipe(Effect.map(({ session }) => session));
      const unpinned = yield* start({});
      assert.includeMembers(unpinned.getActiveToolNames(), ["grep", "find", "ls"]);

      const child = yield* start(
        piChildTools(directory, Option.some({ PATH: "/usr/bin:/bin", USINE_REQUEST_ONLY: "yes" })),
      );
      assert.sameMembers(child.getActiveToolNames(), childTools);
      assert.sameMembers(
        child.getAllTools().map(({ name }) => name),
        childTools,
      );
      const bash = child.getToolDefinition("bash");
      assert(bash !== undefined);
      const names = yield* environmentNames(bash);
      assert(names.includes("USINE_REQUEST_ONLY"));
      assert.notInclude(names, "USINE_ORCHESTRATOR_ONLY");
      assert.deepStrictEqual(names.filter(notShellSet(["PATH", "USINE_REQUEST_ONLY"])), []);
    }).pipe(Effect.scoped),
  );

  it.effect("disposes a child session that resolves after launch interruption", () => {
    const delayed = delayedPiStart();
    const sdk = Layer.succeed(PiSdk)({
      start: delayed.start,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const launchFiber = yield* Effect.forkChild(backend.launch(childRequest));
        yield* Effect.promise(() => delayed.startCalled);
        const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(launchFiber));
        yield* Effect.yieldNow;
        delayed.resolve({
          _tag: "Started",
          model: childRequest.session.brain.model,
          pool: "apiKeys",
        });
        yield* Effect.promise(() => delayed.disposed);
        yield* Fiber.join(interruptFiber);
        assert.strictEqual(delayed.disposeCount(), 1);
      }).pipe(Effect.provide(piChildLayer.pipe(Layer.provideMerge(sdk)))),
    );
  });

  it.effect("maps Pi SDK trouble to a session operation failure", () => {
    const sdk = Layer.succeed(PiSdk)({
      start: () => Promise.reject(new Error("provider unavailable")),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const error = yield* Effect.flip(backend.launch(childRequest));
        const matchesError = Schema.is(SessionOperationError)(error);
        assert(matchesError);
        assert.strictEqual(error.operation, "launch");
      }).pipe(Effect.provide(piChildLayer.pipe(Layer.provideMerge(sdk)))),
    );
  });

  for (const scenario of [
    {
      name: "classifies a terminal overload when SDK retries are disabled",
      message: "HTTP 529: overloaded_error",
      retry: { enabled: false },
      responses: 1,
      outcome: "capacity",
    },
    {
      name: "classifies HTTP 529 when the SDK does not recognize it as retryable",
      message: "HTTP 529",
      retry: {},
      responses: 1,
      outcome: "capacity",
    },
    {
      name: "classifies capacity after SDK retries are exhausted",
      message: "HTTP 529: overloaded_error",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      responses: 2,
      outcome: "capacity",
    },
    {
      name: "finishes successfully when an SDK retry recovers from an overload",
      message: "HTTP 529: overloaded_error",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      responses: 1,
      outcome: "success",
    },
  ]) {
    it.live(scenario.name, () =>
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "usine-pi-capacity-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
        );
        const faux = fauxProvider();
        faux.setResponses([
          ...Array.from({ length: scenario.responses }, () =>
            fauxAssistantMessage([], { stopReason: "error", errorMessage: scenario.message }),
          ),
          fauxAssistantMessage("Recovered"),
        ]);
        const modelRuntime = yield* Effect.promise(() =>
          ModelRuntime.create({
            authPath: join(directory, "auth.json"),
            modelsPath: null,
            refreshOnCreate: false,
          }),
        );
        modelRuntime.registerNativeProvider(faux.provider);
        const { session } = yield* Effect.acquireRelease(
          Effect.promise(() =>
            createAgentSession({
              agentDir: directory,
              cwd: directory,
              model: faux.getModel(),
              modelRuntime,
              tools: [],
              sessionManager: SessionManager.inMemory(directory),
              settingsManager: SettingsManager.inMemory({ retry: scenario.retry }),
            }),
          ),
          ({ session }) => Effect.sync(() => session.dispose()),
        );
        const sdk = Layer.succeed(PiSdk)({
          start: () =>
            Promise.resolve({
              _tag: "Started",
              harnessSession: Option.none(),
              model: ModelId.make(`${faux.provider.id}/${faux.getModel().id}`),
              pool: "apiKeys",
              session,
              tools: [],
            }),
        });
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(childRequest);
          if (scenario.outcome === "capacity") {
            const error = yield* Effect.flip(running.result);
            const matchesError = Schema.is(AgentCapacityError)(error);
            assert(matchesError);
            assert.strictEqual(error.message, scenario.message);
            assert.deepStrictEqual(error.sessionId, Option.some(childRequest.session.id));
          } else {
            const result = yield* running.result;
            assert.strictEqual(result.message, "Recovered");
          }
          assert.strictEqual(
            faux.state.callCount,
            scenario.responses + (scenario.outcome === "success" ? 1 : 0),
          );
        }).pipe(Effect.provide(piChildLayer.pipe(Layer.provideMerge(sdk))));
      }).pipe(Effect.scoped),
    );
  }
});
