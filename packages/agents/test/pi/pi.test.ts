import { assert, describe, it } from "@effect/vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Agent, Attempt, AttemptChannel, Repository } from "@usine/core";
import { Effect, Layer, Option, Stream } from "effect";
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
  piParentLayer,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
} from "../../src/pi/pi.ts";

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
        listener?.({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Pi child done." }] },
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
        return Promise.resolve({ _tag: "Started", model: effectiveModel, session });
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
    const sdk = Layer.succeed(PiSdk)({
      start: () => Promise.resolve({ _tag: "ApiKeyRequired", model }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* PiChildBackend;
        const error = yield* Effect.flip(backend.launch(childRequest));
        assert(error instanceof PoolUnavailableError);
        assert.strictEqual(error.pool, "apiKeys");
        assert.strictEqual(error.model, model);
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
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
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
        return Promise.resolve({ _tag: "Started", model: parentModel, session });
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

  it.effect("rejects a parent model outside the API-key pool", () => {
    const model = Agent.ModelId.make("openai-codex/gpt-5.6-sol");
    const sdk = Layer.succeed(PiSdk)({
      start: () => Promise.resolve({ _tag: "ApiKeyRequired", model }),
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
        return Promise.resolve({ _tag: "Started", model: parentModel, session });
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
          await extension.factory({ registerTool: (tool) => (registered = tool) } as ExtensionAPI);
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
