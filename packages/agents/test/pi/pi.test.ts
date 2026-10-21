import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { Effect, Fiber, Layer, Logger, Option, Queue, Stream } from "effect";
import {
  AgentResultError,
  ChildRequest,
  PiChildBackend,
  PoolUnavailableError,
  SessionOperationError,
  toAttemptFailure,
  UnknownModelError,
  WorkingDirectory,
  type OnDelivery,
} from "../../src/runtime.ts";
import { LocalProcess, RemoteShell } from "../../src/child-host/child-host.ts";
import { piChildBackendLayer } from "../../src/pi/pi.ts";
import {
  environmentBashTool,
  PiSdk,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
  type PiStartResult,
} from "../../src/pi/sdk.ts";
import { resolvePiPool } from "../../src/pi/authentication.ts";

/** Ignores whether a queued operator message is read; the test does not observe it. */
const noDelivery: OnDelivery = () => Effect.void;

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
    worker: WorkerName.make("worker-1"),
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
          noDelivery,
        );
        assert.strictEqual(state.held, true);
        first.complete();
        yield* Queue.take(idle);
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* running.intervene(
          new AttemptChannel.OperatorMessage({ message: "Now fix the edge case" }),
          noDelivery,
        );
        const second = yield* Queue.take(turns);
        assert.strictEqual(second.text, "Now fix the edge case");
        second.complete();
        yield* Queue.take(idle);
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* running.intervene(new AttemptChannel.Release(), noDelivery);
        assert.strictEqual((yield* Fiber.join(result)).message, "Pi session completed");
        assert.strictEqual(opens, 1);
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk));
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
            model: childRequest.session.brain.model,
            pool: "apiKeys",
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
        const running = yield* (yield* PiChildBackend).launch(childRequest);
        const reads: Array<Option.Option<AttemptChannel.InterventionState>> = [];
        const state = yield* running.intervene(
          new AttemptChannel.OperatorMessage({ message: "Use pnpm, not npm." }),
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
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk));
    }).pipe(Effect.scoped),
  );

  it.effect("normalizes session events and forwards input and controls", () => {
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
        // Operational SDK events with no normalized shape are logged and
        // skipped; they must never enter the queue or break the bridge.
        publish({ type: "compaction_start", reason: "threshold" });
        publish({
          type: "message_end",
          message: fauxAssistantMessage("Pi child done."),
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
          ["SessionStarted", "SessionTokensUpdated", "TextOutput", "SessionFinished"],
        );
      }).pipe(Effect.provide(piChildBackendLayer), Effect.provide(sdk)),
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
        // The next turn counts from 1 again, and a retry Pi gives up on records no recovery.
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
          model: childRequest.session.brain.model,
          pool: "apiKeys",
          session,
        }),
    });
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(JSON.stringify(message));
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const running = yield* (yield* PiChildBackend).launch(childRequest);
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
        Effect.provide(piChildBackendLayer),
        Effect.provide(sdk),
        Effect.provide(Logger.layer([logger])),
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
          {} as ExtensionToolContext,
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
