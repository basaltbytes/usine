import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Fiber, Layer, Option, Queue, Stream } from "effect";
import {
  AgentResultError,
  ChildRequest,
  PiChildBackend,
  PoolUnavailableError,
  SessionOperationError,
  toAttemptFailure,
  UnknownModelError,
  WorkingDirectory,
} from "@usine/agents/runtime";
import { LocalProcess, RemoteShell } from "@usine/agents/child-host";
import {
  PiSdk,
  piChildBackendLayer,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
  type PiStartResult,
} from "@usine/agents/pi";
import { environmentBashTool } from "../../src/pi/sdk.ts";
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

describe("Pi child backend", () => {
  const childRequest = new ChildRequest({
    environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
    host: new LocalProcess(),
    session: new ChildSession({
      id: AgentSessionId.make("pi-child-1"),
      parentId: AgentSessionId.make("parent-1"),
      agent: AgentName.make("developer"),
      brain: new BrainSpec({
        harness: "pi",
        model: ModelId.make("openai/gpt-5.6-terra"),
        effort: "medium",
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/usine"),
    prompt: "Implement the focused task.",
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
            model: childRequest.session.brain.model,
            pool: "apiKeys",
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
        const running = yield* (yield* PiChildBackend).launch(childRequest);
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
          new AttemptChannel.OperatorMessage({ message: "Wait for my review" }),
        );
        assert.strictEqual(state.held, true);
        first.complete();
        yield* Queue.take(idle);
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* running.intervene(
          new AttemptChannel.OperatorMessage({ message: "Now fix the edge case" }),
        );
        const second = yield* Queue.take(turns);
        assert.strictEqual(second.text, "Now fix the edge case");
        second.complete();
        yield* Queue.take(idle);
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* running.intervene(new AttemptChannel.Release());
        assert.strictEqual((yield* Fiber.join(result)).message, "Pi session completed");
        assert.strictEqual(opens, 1);
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk));
    }).pipe(Effect.scoped),
  );

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
    const effectiveModel = ModelId.make("openai/gpt-5.6-terra-2026-08-01");
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
        assert.deepStrictEqual(
          options?.extensions.map(({ name }) => name),
          ["usine-session-intervention"],
        );
        assert.strictEqual(options?.model, childRequest.session.brain.model);
        assert.deepStrictEqual(options?.environment, Option.some(childRequest.environment));
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["SessionStarted", "TextOutput", "SessionFinished"],
        );
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk)),
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
          (yield* PiChildBackend).launch(
            new ChildRequest({
              ...childRequest,
              host: new RemoteShell({
                ssh: { command: "ssh", args: [] },
                sshEnvironment: {},
                destination: "worker.exe.xyz",
              }),
            }),
          ),
        );
        assert(error instanceof AgentResultError);
        assert.match(error.message, /^Pi children run only on local Workers/u);
        assert.strictEqual(toAttemptFailure(error)._tag, "AgentFailure");
        assert.strictEqual(started, false);
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
    const model = ModelId.make("openai-codex/gpt-5.6-sol");
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

  it.effect("runs a child's bash commands with exactly its environment and nothing inherited", () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "usine-pi-bash-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
      );
      const bash = environmentBashTool(directory, { PATH: "/usr/bin:/bin", USINE_ONLY: "yes" });
      const result = yield* Effect.promise(() =>
        bash.execute(
          "call-1",
          { command: "env" },
          undefined,
          undefined,
          // SAFETY: without session variables the bash tool reads only the optional `cwd` of its context.
          {} as ExtensionContext,
        ),
      );
      const output = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
      const names = output
        .join("\n")
        .split("\n")
        .flatMap((line) => (line.includes("=") ? [line.slice(0, line.indexOf("="))] : []));
      assert(names.includes("USINE_ONLY"));
      // The shell itself sets PWD, SHLVL, and _ for every command.
      assert.deepStrictEqual(
        names.filter(
          (name) => !["PATH", "USINE_ONLY", "PWD", "OLDPWD", "SHLVL", "_"].includes(name),
        ),
        [],
      );
    }).pipe(Effect.scoped),
  );

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
