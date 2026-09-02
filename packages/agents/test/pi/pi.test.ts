import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Agent, Attempt, AttemptChannel, Repository } from "@usine/core";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { Type } from "typebox";
import {
  AgentRuntime,
  ChildBackend,
  ChildRequest,
  LaunchRequest,
  PiChildBackend,
  PoolUnavailableError,
  SessionOperationError,
  SessionResult,
  UnknownModelError,
  WorkingDirectory,
} from "../../src/index.ts";
import {
  PiSdk,
  piChildBackendLayer,
  piParentSessionToolPolicy,
  piParentLayer,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
  type PiStartResult,
} from "../../src/pi/pi.ts";
import { resolvePiPool } from "../../src/pi/authentication.ts";

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
    resolve: (result: Omit<Extract<PiStartResult, { readonly _tag: "Started" }>, "session">) => {
      assert(resolveStart !== undefined);
      resolveStart({ ...result, session });
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

const agent = new Agent.Agent({
  name: Agent.Name.make("developer"),
  brain: new Agent.BrainSpec({
    harness: "claude",
    model: Agent.ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  persona: Agent.Persona.make("Implement the issue carefully."),
});

describe("Pi child backend", () => {
  const childRequest = new ChildRequest({
    session: new Agent.ChildSession({
      id: Agent.SessionId.make("pi-child-1"),
      parentId: Agent.SessionId.make("parent-1"),
      agent: Agent.Name.make("developer"),
      brain: new Agent.BrainSpec({
        harness: "pi",
        model: Agent.ModelId.make("openai/gpt-5.6-terra"),
        effort: "medium",
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/usine"),
    prompt: "Implement the focused task.",
  });

  it.effect("normalizes session events and forwards input and controls", () => {
    let options: PiStartOptions | undefined;
    let listener: ((event: PiSessionEvent) => void) | undefined;
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
        // Operational SDK events with no normalized shape are logged and
        // skipped; they must never enter the queue or break the bridge.
        listener?.({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 250,
          errorMessage: "overloaded",
        });
        listener?.({ type: "auto_retry_end", success: true, attempt: 1 });
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Pi child done." }],
          },
        });
        return Promise.resolve();
      },
      steer: (value) => {
        steer = value;
        return Promise.resolve();
      },
      subscribe: (found) => {
        listener = found;
        return () => undefined;
      },
    };
    const effectiveModel = Agent.ModelId.make("openai/gpt-5.6-terra-2026-08-01");
    const sdk = Layer.succeed(PiSdk)({
      start: (found) => {
        options = found;
        return Promise.resolve({
          _tag: "Started",
          model: effectiveModel,
          pool: "apiKeys",
          session,
        });
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* PiChildBackend;
        const running = yield* backend.launch(childRequest);
        yield* running.steer("Check the test output.");
        yield* running.interrupt;
        const [events, result] = yield* Effect.all([
          Stream.runCollect(running.events),
          running.result,
        ]);
        assert.strictEqual(result.message, "Pi child done.");
        assert.strictEqual(running.session.brain.model, effectiveModel);
        assert.strictEqual(prompt, childRequest.prompt);
        assert.strictEqual(steer, "Check the test output.");
        assert.strictEqual(interrupted, true);
        assert.deepStrictEqual(options?.extensions, []);
        assert.deepStrictEqual(options?.model, Option.some(childRequest.session.brain.model));
        assert.strictEqual(options?.toolMode, "repository");
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["SessionStarted", "TextOutput", "SessionFinished"],
        );
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk)),
    );
  });

  it.effect("surfaces an unknown configured child model as a typed failure", () => {
    const sdk = Layer.succeed(PiSdk)({
      start: () => Promise.resolve({ _tag: "UnknownModel" }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* PiChildBackend;
        const error = yield* Effect.flip(backend.launch(childRequest));
        assert(error instanceof UnknownModelError);
        assert.strictEqual(error.harness, "pi");
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk)),
    );
  });

  it.effect("rejects a child model outside the API-key pool", () => {
    const model = Agent.ModelId.make("openai-codex/gpt-5.6-sol");
    let disposed = false;
    const session: PiSession = {
      abort: () => Promise.resolve(),
      dispose: () => {
        disposed = true;
      },
      messages: [],
      prompt: () => Promise.resolve(),
      steer: () => Promise.resolve(),
      subscribe: () => () => undefined,
    };
    const sdk = Layer.succeed(PiSdk)({
      start: () =>
        Promise.resolve({
          _tag: "Started",
          model,
          pool: "chatgptPlan",
          session,
        }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* PiChildBackend;
        const error = yield* Effect.flip(backend.launch(childRequest));
        assert(error instanceof PoolUnavailableError);
        assert.strictEqual(error.pool, "apiKeys");
        assert.strictEqual(error.model, model);
        assert.strictEqual(disposed, true);
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk)),
    );
  });

  it.effect("disposes a child session that resolves after launch interruption", () => {
    const delayed = delayedPiStart();
    const sdk = Layer.succeed(PiSdk)({
      start: delayed.start,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* PiChildBackend;
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
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk)),
    );
  });

  it.effect("maps Pi SDK trouble to a session operation failure", () => {
    const sdk = Layer.succeed(PiSdk)({
      start: () => Promise.reject(new Error("provider unavailable")),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* PiChildBackend;
        const error = yield* Effect.flip(backend.launch(childRequest));
        assert(error instanceof SessionOperationError);
        assert.strictEqual(error.operation, "launch");
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk)),
    );
  });
});
const parentModel = Agent.ModelId.make("anthropic/claude-opus-4-6");
const request = new LaunchRequest({
  spec: new AttemptChannel.RunSpec({
    attemptId: Attempt.AttemptId.make("run/step/1"),
    repository: Repository.Name.make("basaltbytes/usine"),
    revision: Repository.Revision.make("main"),
    baseCommit: Repository.CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
    payload: { number: 30 },
    task: AttemptChannel.Task.make("Implement issue 30."),
    agent,
    parentModel: Option.some(parentModel),
  }),
  cwd: WorkingDirectory.make("/workspace/usine"),
});

const childLayer = Layer.succeed(ChildBackend)({
  launch: () => Effect.die("parent test never invokes the subagent tool"),
});

describe("Pi parent runtime", () => {
  it.effect("keeps repository tools out of a real parent session", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "usine-pi-parent-tools-"))),
      (directory) =>
        Effect.promise(async () => {
          const settingsManager = SettingsManager.create(directory, directory, {
            projectTrusted: false,
          });
          const resourceLoader = new DefaultResourceLoader({
            agentDir: directory,
            cwd: directory,
            extensionFactories: [
              {
                name: "test-subagents",
                factory: (pi) =>
                  pi.registerTool(
                    defineTool({
                      name: "subagent",
                      label: "Subagent",
                      description: "Delegate work.",
                      parameters: Type.Object({}, { additionalProperties: false }),
                      execute: async () => ({ content: [], details: {} }),
                    }),
                  ),
              },
            ],
            settingsManager,
            noExtensions: true,
            noPromptTemplates: true,
            noSkills: true,
            noThemes: true,
          });
          await resourceLoader.reload();
          const { session } = await createAgentSession({
            agentDir: directory,
            cwd: directory,
            ...piParentSessionToolPolicy,
            resourceLoader,
            sessionManager: SessionManager.inMemory(directory),
            settingsManager,
          });
          try {
            assert.deepStrictEqual(session.getActiveToolNames(), ["subagent"]);
          } finally {
            session.dispose();
          }
        }),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    ),
  );

  it.effect("assembles the full prompt, normalizes SDK events, and forwards controls", () => {
    let options: PiStartOptions | undefined;
    let listener: ((event: PiSessionEvent) => void) | undefined;
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
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        });
        listener?.({
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "pnpm test" },
        });
        listener?.({
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "bash",
          result: "passed",
          isError: false,
        });
        return Promise.resolve();
      },
      steer: (value) => {
        steer = value;
        return Promise.resolve();
      },
      subscribe: (found) => {
        listener = found;
        return () => undefined;
      },
    };
    const sdk = Layer.succeed(PiSdk)({
      start: (found) => {
        options = found;
        return Promise.resolve({
          _tag: "Started",
          model: parentModel,
          pool: "apiKeys",
          session,
        });
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const running = yield* runtime.launch(request);
        yield* running.steer("Check the failing test.");
        yield* running.interrupt;
        const [events, result] = yield* Effect.all([
          Stream.runCollect(running.events),
          running.result,
        ]);
        assert.strictEqual(result.message, "done");
        assert.match(prompt, /Repository: basaltbytes\/usine/u);
        assert.match(prompt, /"number": 30/u);
        assert.match(prompt, /Implement the issue carefully/u);
        assert.match(prompt, /— usine agent: developer/u);
        assert.strictEqual(steer, "Check the failing test.");
        assert.strictEqual(interrupted, true);
        assert.strictEqual(options?.extensions.length, 1);
        assert.strictEqual(options?.toolMode, "orchestration");
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["SessionStarted", "TextOutput", "ToolStarted", "ToolFinished", "SessionFinished"],
        );
      }).pipe(Effect.provide(piParentLayer), Effect.provide(sdk), Effect.provide(childLayer)),
    );
  });

  it.effect("surfaces an unknown configured parent model as a typed failure", () => {
    const sdk = Layer.succeed(PiSdk)({
      start: () => Promise.resolve({ _tag: "UnknownModel" }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const error = yield* Effect.flip(runtime.launch(request));
        assert(error instanceof UnknownModelError);
        assert.strictEqual(error.model, parentModel);
      }).pipe(Effect.provide(piParentLayer), Effect.provide(sdk), Effect.provide(childLayer)),
    );
  });

  it.effect("runs a parent model from the ChatGPT subscription pool", () => {
    const model = Agent.ModelId.make("openai-codex/gpt-5.6-sol");
    let listener: ((event: PiSessionEvent) => void) | undefined;
    const session: PiSession = {
      abort: () => Promise.resolve(),
      dispose: () => undefined,
      messages: [],
      prompt: () => {
        listener?.({
          type: "message_end",
          message: { role: "assistant", content: "subscription parent done" },
        });
        return Promise.resolve();
      },
      steer: () => Promise.resolve(),
      subscribe: (found) => {
        listener = found;
        return () => undefined;
      },
    };
    const sdk = Layer.succeed(PiSdk)({
      start: () =>
        Promise.resolve({
          _tag: "Started",
          model,
          pool: "chatgptPlan",
          session,
        }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const running = yield* runtime.launch(request);
        const result = yield* running.result;
        assert.strictEqual(running.session.brain.model, model);
        assert.strictEqual(result.message, "subscription parent done");
      }).pipe(Effect.provide(piParentLayer), Effect.provide(sdk), Effect.provide(childLayer)),
    );
  });

  it.effect("rejects an OAuth parent without a known billing pool", () => {
    const model = Agent.ModelId.make("github-copilot/gpt-5.6-sol");
    const sdk = Layer.succeed(PiSdk)({
      start: () =>
        Promise.resolve({
          _tag: "UnsupportedAuthentication",
          authentication: { _tag: "OAuth", subscription: true },
          model,
          requiredPool: "apiKeys",
        }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const error = yield* Effect.flip(runtime.launch(request));
        assert(error instanceof PoolUnavailableError);
        assert.strictEqual(error.pool, "apiKeys");
        assert.strictEqual(error.model, model);
      }).pipe(Effect.provide(piParentLayer), Effect.provide(sdk), Effect.provide(childLayer)),
    );
  });

  it.effect("reports a missing parent credential as a terminal pool failure", () => {
    const model = Agent.ModelId.make("openai-codex/gpt-5.6-sol");
    const sdk = Layer.succeed(PiSdk)({
      start: () =>
        Promise.resolve({
          _tag: "AuthenticationUnavailable",
          model,
          requiredPool: "chatgptPlan",
        }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const error = yield* Effect.flip(runtime.launch(request));
        assert(error instanceof PoolUnavailableError);
        assert.strictEqual(error.pool, "chatgptPlan");
        assert.strictEqual(error.model, model);
      }).pipe(Effect.provide(piParentLayer), Effect.provide(sdk), Effect.provide(childLayer)),
    );
  });

  it.effect("disposes a parent session that resolves after launch interruption", () => {
    const delayed = delayedPiStart();
    const sdk = Layer.succeed(PiSdk)({
      start: delayed.start,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const launchFiber = yield* Effect.forkChild(runtime.launch(request));
        yield* Effect.promise(() => delayed.startCalled);
        const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(launchFiber));
        yield* Effect.yieldNow;
        delayed.resolve({
          _tag: "Started",
          model: parentModel,
          pool: "apiKeys",
        });
        yield* Effect.promise(() => delayed.disposed);
        yield* Fiber.join(interruptFiber);
        assert.strictEqual(delayed.disposeCount(), 1);
      }).pipe(Effect.provide(piParentLayer), Effect.provide(sdk), Effect.provide(childLayer)),
    );
  });

  it.effect("runs subagent tool programs on the launch fiber's own services", () => {
    // Pi invokes the tool callback outside any usine fiber. A detached
    // Effect.runPromise would reset every fiber reference to its default —
    // notably the stderr log redirect, whose loss corrupts the protocol
    // stdout — so the runner must carry the launch context into the child.
    let options: PiStartOptions | undefined;
    const session: PiSession = {
      abort: () => Promise.resolve(),
      dispose: () => undefined,
      messages: [],
      prompt: () => Promise.resolve(),
      steer: () => Promise.resolve(),
      subscribe: () => () => undefined,
    };
    const sdk = Layer.succeed(PiSdk)({
      start: (found) => {
        options = found;
        return Promise.resolve({
          _tag: "Started",
          model: parentModel,
          pool: "apiKeys",
          session,
        });
      },
    });
    let sawLaunchContext = false;
    const child = Layer.succeed(ChildBackend)({
      launch: (childRequest) =>
        Effect.gen(function* () {
          sawLaunchContext = Option.isSome(yield* Effect.serviceOption(PiSdk));
          return {
            session: childRequest.session,
            events: Stream.empty,
            result: Effect.succeed(new SessionResult({ message: "child done" })),
            steer: () => Effect.void,
            interrupt: Effect.void,
          };
        }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        yield* runtime.launch(request);
        const extension = options?.extensions[0];
        assert(extension !== undefined);
        let registered: ToolDefinition | undefined;
        yield* Effect.promise(async () => {
          // SAFETY: this extension only calls registerTool; other members are unused.
          await extension.factory({
            registerTool: (tool) => (registered = tool),
          } as ExtensionAPI);
        });
        assert(registered !== undefined);
        const result = yield* Effect.promise(() =>
          // SAFETY: the owned subagent tool does not read ExtensionContext.
          registered!.execute(
            "tool-1",
            { task: "Prove context propagation." },
            undefined,
            undefined,
            {} as ExtensionContext,
          ),
        );
        assert.strictEqual(result.content[0]?.text, "child done");
        assert.strictEqual(sawLaunchContext, true);
      }).pipe(Effect.provide(piParentLayer), Effect.provide(sdk), Effect.provide(child)),
    );
  });
});
