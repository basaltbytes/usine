import type { ClaudeUserMessage } from "../../src/harness/claude/sdk.ts";
import { jsonKey } from "@usine/core/json-key";
// SDK streams and hooks require native Promises, including the test implementations.
// @effect-diagnostics newPromise:off
// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, describe, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import { BrainSpec, Effort, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  HarnessSession,
  HarnessSessionId,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  TokenCount,
  UsdAmount,
  sessionPool,
} from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Sink,
  Stream,
} from "effect";
import { createInterface } from "node:readline";
import { jsonLine, scriptedOwner, scriptedTarget } from "../child-host/scripted-owner.ts";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import {
  Interrupt,
  OperatorMessage,
  OperatorMessageId,
  Release,
  Steer,
} from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { type ChildHost, LocalProcess, RemoteShell } from "../../src/child-host/child-host.ts";
import { ChildProcessLost } from "../../src/child-host/process.ts";
import {
  AgentResultError,
  AgentCapacityError,
  ChildBackend,
  ChildRequest,
  ChildSessionJournal,
  ChildSessionLifecycle,
  HostLoginLock,
  type OnDelivery,
  SessionOperationError,
  UnknownModelError,
  WorkingDirectory,
} from "../../src/runtime.ts";
import {
  ClaudeSdk,
  claudeChildLayer,
  type ClaudeQuery,
  type ClaudeQueryOptions,
} from "../../src/harness/claude/claude.ts";

/** A single login lock for all Workers, since each test launches its children on one Worker. */
const loginLock = Layer.effect(
  HostLoginLock,
  Effect.map(Semaphore.make(1), (mutex) =>
    HostLoginLock.of({ withLock: () => (effect) => mutex.withPermit(effect) }),
  ),
);

const encoder = new TextEncoder();
// The fake SDK decodes each stdout line inside its async iterator.
// @effect-diagnostics-next-line schemaSync:off
const decodeStdoutLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/**
 * Returns a process spawner for the backend's commands on Workers, which records each command line
 * and answers it with `exitCode` and `stdout`.
 */
const workerCommands = (exitCode: number, stdout = "") => {
  const commands: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
        commands.push([command.command, ...command.args]);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
  return { commands, layer };
};

/** The Claude backend, with a login lock that the test can also acquire, and `commands` on Workers. */
const claudeChildWith = (commands: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  claudeChildLayer.pipe(
    Layer.provideMerge(loginLock),
    Layer.provide(commands),
    Layer.provide(NodeCrypto.layer),
  );

const claudeChild = claudeChildWith(workerCommands(0).layer);

/** The event that shows Claude's first API request succeeded with a working login. */
const rateLimitEvent = { type: "rate_limit_event", rate_limit_info: { status: "allowed" } };

const noDelivery: OnDelivery = () => Effect.void;

const request = (
  model = "claude-sonnet-4-6",
  options?: { readonly harness?: Harness; readonly effort?: Effort },
  host: ChildHost = LocalProcess.make(),
) =>
  ChildRequest.make({
    worker: WorkerName.make("worker-1"),
    machine: Option.none(),
    environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
    host,
    session: ChildSession.make({
      id: AgentSessionId.make("parent:attempt-1:child:1"),
      parentId: AgentSessionId.make("parent:attempt-1"),
      agent: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("claude"),
        model: ModelId.make(model),
        effort: "high",
        ...options,
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/repo"),
    prompt: "Implement the focused task.",
  });

const scripted = (
  messages: ReadonlyArray<Schema.Json>,
  models: ReadonlyArray<{ readonly value: string; readonly resolvedModel?: string }> = [
    { value: "sonnet", resolvedModel: "claude-sonnet-4-6" },
  ],
  sessionId = "claude-session-1",
): ClaudeQuery => ({
  close: () => undefined,
  interrupt: () => Promise.resolve(),
  usesApiKey: () => Promise.resolve(false),
  supportedModels: () => Promise.resolve(models),
  async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: sessionId };
    for (const message of messages) yield message;
  },
});

const LOGIN_ERROR =
  "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again";

/** Claude Code's output when another process has its login refresh lock: an error and a result, with no tokens used. */
const loginContended: ReadonlyArray<Schema.Json> = [
  {
    type: "assistant",
    error: "authentication_failed",
    message: {
      id: "login-error",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: "text", text: LOGIN_ERROR }],
    },
  },
  { type: "result", subtype: "success", is_error: true, result: LOGIN_ERROR, modelUsage: {} },
];

/**
 * Returns a fake Claude SDK whose first `contended` launches lose the login refresh lock and whose
 * later launches finish the task. A launch that lost the lock keeps its output open until it is
 * closed, as in Claude Code's streaming-input sessions.
 */
const loginRace = (contended: number) => {
  const launches: Array<{ closed: boolean; id: string | undefined; resume: string | undefined }> =
    [];
  const sdk = Layer.succeed(ClaudeSdk)({
    open: (_input, options) => {
      if (options.sessionId !== undefined && launches.some(({ id }) => id === options.sessionId))
        throw new Error(`Session ID ${options.sessionId} is already in use.`);
      const launch = { closed: false, id: options.sessionId, resume: options.resume };
      launches.push(launch);
      const lostLock = launches.length <= contended;
      let endOutput = () => {};
      const outputEnded = new Promise<void>((resolve) => {
        endOutput = resolve;
      });
      const query = scripted(
        lostLock
          ? loginContended
          : [
              {
                type: "assistant",
                message: { content: [{ type: "text", text: "Child completed the edit." }] },
              },
              { type: "result", subtype: "success", result: "Child completed the edit." },
            ],
        undefined,
        `claude-session-${launches.length}`,
      );
      return {
        ...query,
        close: () => {
          launch.closed = true;
          endOutput();
        },
        // An async generator, like the live SDK's, cannot return while it waits for a message.
        async *[Symbol.asyncIterator]() {
          yield* query;
          if (lostLock) await outputEnded;
        },
      };
    },
  });
  return { launches, sdk };
};

/** Returns a logger `layer` and the info lines logged where it is provided. */
/** Collects the messages logged at `levels`. */
const logLines = (levels: ReadonlyArray<string>) => {
  const lines: Array<string> = [];
  // The level of each entry in `lines`, at the same index.
  const lineLevels: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (!levels.includes(logLevel)) return;
    lines.push(jsonKey(message));
    lineLevels.push(logLevel);
  });
  return { lines, lineLevels, layer: Logger.layer([logger]) };
};

const infoLines = () => logLines(["Info"]);

/**
 * A Claude SDK whose output stays open, after the login check, until the test offers more.
 * `query.closed` is whether the session closed the query.
 */
const openOutput = (messages: ReadonlyArray<Schema.Json>) =>
  Effect.gen(function* () {
    const output = yield* Queue.make<Schema.Json, Cause.Done>();
    yield* Queue.offerAll(output, [rateLimitEvent, ...messages]);
    const query = { closed: false };
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () => ({
        ...scripted([]),
        close: () => {
          query.closed = true;
          Queue.endUnsafe(output);
        },
        [Symbol.asyncIterator]: () =>
          Stream.toAsyncIterable(Stream.fromQueue(output))[Symbol.asyncIterator](),
      }),
    });
    return { output, query, sdk };
  });

/** Advances the test clock in 5-second steps until `fiber` ends. */
const joinAdvancingClock = Effect.fn(function* <A, E>(fiber: Fiber.Fiber<A, E>) {
  while (fiber.pollUnsafe() === undefined) yield* TestClock.adjust("5 seconds");
  return yield* Fiber.join(fiber);
});

/** A remote host whose SSH client exits with `code` at once: `SSH_FAILURE` for a broken connection. */
const exitingHost = (code: number) =>
  RemoteShell.make({
    ssh: { command: process.execPath, args: ["-e", `process.exit(${code})`] },
    sshEnvironment: {},
    destination: "worker.exe.xyz",
  });

describe("Claude child backend", () => {
  const changed = {
    configured: "configured home",
    default: "default home",
    checkout: "checkout",
  } as const;
  for (const home of ["configured", "default", "checkout"] as const) {
    it.effect(`refuses a saved remote child with a changed ${changed[home]}`, () => {
      const original = request();
      const worker = workerCommands(0);
      let opened = false;
      const sdk = Layer.succeed(ClaudeSdk)({
        open: () => {
          opened = true;
          return scripted([]);
        },
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const error = yield* (yield* ChildBackend)
            .launch(
              ChildRequest.make({
                ...original,
                host: exitingHost(0),
                environment:
                  home === "configured"
                    ? { ...original.environment, CLAUDE_CONFIG_DIR: "/new-claude" }
                    : home === "default"
                      ? { ...original.environment, HOME: "/new-home" }
                      : original.environment,
                resume: Option.some(
                  HarnessSession.make({
                    id: HarnessSessionId.make("saved-claude"),
                    cwd: home === "checkout" ? "/workspace/old-checkout" : original.cwd,
                    home:
                      home === "checkout"
                        ? Option.none()
                        : Option.some(home === "configured" ? "/old-claude" : "/old-home/.claude"),
                  }),
                ),
              }),
            )
            .pipe(Effect.flip);
          assert(error._tag === "ContinuationMismatchError");
          assert.strictEqual(error.field, home === "checkout" ? "cwd" : "home");
          assert.include(
            error.message,
            home === "checkout" ? "saved /workspace/old-checkout" : "home mismatch",
          );
          assert.deepStrictEqual(worker.commands, []);
          assert.isFalse(opened, "refusal cannot start another Claude process");
        }),
      ).pipe(Effect.provide(claudeChildWith(worker.layer).pipe(Layer.provide(sdk))));
    });
  }

  it.effect("reports a failed native reopen as interrupted", () => {
    const saved = HarnessSession.make({ cwd: request().cwd });
    const sdk = Layer.succeed(ClaudeSdk)({
      open: (_input, options) => {
        assert.strictEqual(options.resume, saved.id);
        assert.isUndefined(options.sessionId);
        return {
          ...scripted([]),
          supportedModels: async () => {
            throw new Error("Saved conversation unavailable");
          },
        };
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const error = yield* (yield* ChildBackend)
          .launch(ChildRequest.make({ ...request(), resume: Option.some(saved) }))
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "SessionInterruptedError");
      }),
    ).pipe(Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
  });

  it.effect("continues the saved conversation supplied by a restarted durable call", () => {
    const saved = HarnessSession.make({
      id: HarnessSessionId.make("saved-claude"),
      cwd: request().cwd,
      home: Option.some("/worker/attempt/claude"),
    });
    const sdk = Layer.succeed(ClaudeSdk)({
      open: (_input, options) => {
        assert.strictEqual(options.resume, saved.id);
        assert.strictEqual(options.env?.CLAUDE_CONFIG_DIR, "/worker/attempt/claude");
        return scripted(
          [
            {
              type: "result",
              subtype: "success",
              result: "Continued.",
              modelUsage: {
                model: {
                  inputTokens: 400,
                  outputTokens: 100,
                  cacheCreationInputTokens: 0,
                  costUSD: 0.125,
                },
              },
            },
          ],
          undefined,
          saved.id,
        );
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(
          ChildRequest.make({
            ...request(),
            resume: Option.some(saved),
            environment: {
              ...request().environment,
              ...Option.match(saved.home, {
                onNone: () => ({}),
                onSome: (home) => ({ CLAUDE_CONFIG_DIR: home }),
              }),
            },
            usage: Option.some({
              totalTokens: TokenCount.make(1000),
              costUsd: Option.some(UsdAmount.make(0.25)),
            }),
          }),
        );
        const events = yield* Effect.forkChild(Stream.runCollect(running.events));
        assert.strictEqual((yield* running.result).message, "Continued.");
        const transcript = yield* Fiber.join(events);
        const started = transcript.find((event) => event._tag === "SessionStarted");
        assert(started !== undefined);
        assert.deepStrictEqual(started.harnessSession, Option.some(saved));
        const usage = transcript.filter((event) => event._tag === "SessionTokensUpdated").at(-1);
        assert(usage !== undefined);
        assert.strictEqual(usage.totalTokens, 1500);
        assert.deepStrictEqual(usage.costUsd, Option.some(0.375));
      }),
    ).pipe(Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
  });

  for (const supervision of ["paused", "held-idle", "held-idle-steer"] as const) {
    it.effect(`restores a ${supervision} Claude child without starting a turn`, () =>
      Effect.gen(function* () {
        const output = yield* Queue.make<Schema.Json, Cause.Done>();
        const received = yield* Queue.make<string>();
        const context = yield* Effect.context<never>();
        const saved = HarnessSession.make({
          id: HarnessSessionId.make("paused-claude"),
          cwd: request().cwd,
        });
        const sdk = Layer.succeed(ClaudeSdk)({
          open: (input) => {
            Effect.runForkWith(context)(
              Stream.fromAsyncIterable(input, (cause) =>
                SessionOperationError.make({
                  operation: "stream",
                  sessionId: Option.none(),
                  message: "Claude test input failed",
                  cause,
                }),
              ).pipe(
                Stream.runForEach((message) => Queue.offer(received, message.message.content)),
              ),
            );
            return {
              close: () => {
                Effect.runForkWith(context)(Queue.end(output));
              },
              interrupt: () => Promise.resolve(),
              usesApiKey: () => Promise.resolve(false),
              supportedModels: () => Promise.resolve([{ value: "claude-sonnet-4-6" }]),
              [Symbol.asyncIterator]: () =>
                Stream.toAsyncIterableWith(Stream.fromQueue(output), context)[
                  Symbol.asyncIterator
                ](),
            };
          },
        });
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            ChildRequest.make({
              ...request(),
              resume: Option.some(saved),
              environment: {
                ...request().environment,
                ...Option.match(saved.home, {
                  onNone: () => ({}),
                  onSome: (home) => ({ CLAUDE_CONFIG_DIR: home }),
                }),
              },
              held: supervision !== "paused",
              paused: supervision === "paused",
              idle: supervision === "paused" ? Option.none() : Option.some("Saved final report."),
            }),
          );
          const seen: string[] = [];
          yield* running.events.pipe(
            Stream.take(2),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                seen.push(event._tag);
              }),
            ),
          );
          assert.deepStrictEqual(seen, ["SessionStarted", "SessionIdle"]);
          const beforeRelease = yield* Queue.clear(received);
          assert.deepStrictEqual(beforeRelease, []);
          if (supervision === "held-idle") {
            yield* running.intervene(Release.make(), noDelivery);
            assert.strictEqual((yield* running.result).message, "Saved final report.");
            const afterRelease = yield* Queue.clear(received);
            assert.deepStrictEqual(afterRelease, []);
            return;
          }
          if (supervision === "paused") {
            const state = yield* running.intervene(Release.make(), noDelivery);
            assert.isTrue(state.paused);
            const afterRelease = yield* Queue.clear(received);
            assert.deepStrictEqual(afterRelease, []);
          }
          yield* running.intervene(
            OperatorMessage.make({ message: "Continue with the correction." }),
            noDelivery,
          );
          const guidance = yield* Queue.take(received);
          assert.strictEqual(guidance, "Continue with the correction.");
          const additional = yield* Queue.clear(received);
          assert.deepStrictEqual(additional, []);
          yield* Queue.offer(output, { type: "system", subtype: "init", session_id: saved.id });
          yield* Queue.offer(output, { type: "result", subtype: "success", result: "Corrected." });
          yield* running.intervene(Release.make(), noDelivery);
          assert.strictEqual((yield* running.result).message, "Corrected.");
          const remaining = yield* running.events.pipe(Stream.runCollect);
          assert(!remaining.some((event) => event._tag === "SessionStarted"));
        }).pipe(Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
      }).pipe(Effect.scoped),
    );
  }

  for (const gatewayCredential of [Option.none(), Option.some("subscription" as const)]) {
    it.effect(
      `reports Claude plan windows with ${Option.isSome(gatewayCredential) ? "a gateway subscription" : "the worker login"}`,
      () => {
        const sdk = Layer.succeed(ClaudeSdk)({
          open: () =>
            scripted([
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "allowed_warning",
                  rateLimitType: "five_hour",
                  utilization: 0.82,
                  resetsAt: 1_793_836_800,
                },
              },
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "allowed",
                  rateLimitType: "seven_day",
                  utilization: 0.4,
                  resetsAt: 1_794_355_200,
                },
              },
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "allowed",
                  rateLimitType: "five_hour",
                  utilization: 0,
                },
              },
              ...["seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"].map(
                (rateLimitType) => ({
                  type: "rate_limit_event",
                  rate_limit_info: {
                    status: "rejected",
                    rateLimitType,
                    utilization: 1.25,
                    resetsAt: 1_794_355_200,
                  },
                }),
              ),
              { type: "result", subtype: "success", result: "Done" },
            ]),
        });
        return Effect.gen(function* () {
          const original = request();
          const childRequest = ChildRequest.make({
            ...original,
            session: ChildSession.make({ ...original.session, gatewayCredential }),
          });
          const session = yield* (yield* ChildBackend).launch(childRequest);
          const [events, result] = yield* Effect.all([
            Stream.runCollect(session.events),
            session.result,
          ]);
          assert.strictEqual(result.message, "Done");
          const reports = events.filter(Schema.is(PoolRateLimitsUpdated));
          for (const report of reports) {
            assert.strictEqual(report.pool, "claudePlan");
            assert.deepStrictEqual(report.session, session.session);
            assert.deepStrictEqual(report.session.pool, Option.some("claudePlan"));
            assert.isTrue(Option.isNone(report.login));
          }
          const primary = {
            usedPercent: 82,
            windowDurationMinutes: 300,
            resetsAt: "2026-11-05T00:00:00.000Z",
          };
          const resetPrimary = { usedPercent: 0, windowDurationMinutes: 300, resetsAt: null };
          const secondary = {
            usedPercent: 40,
            windowDurationMinutes: 10_080,
            resetsAt: "2026-11-11T00:00:00.000Z",
          };
          const snapshots = yield* Effect.forEach(reports, ({ rateLimits }) =>
            Schema.encodeEffect(RateLimitsSnapshot)(rateLimits),
          );
          assert.deepStrictEqual(
            snapshots,
            [
              { primary, secondary: null },
              { primary: null, secondary },
              { primary: resetPrimary, secondary: null },
              ...Array.from({ length: 3 }, () => ({
                primary: null,
                secondary: { ...secondary, usedPercent: 125 },
              })),
            ].map((windows) => ({ limitId: null, limitName: null, ...windows })),
          );
        }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk))), Effect.scoped);
      },
    );
  }

  it.effect("skips incomplete or invalid plan reports and emits only the observed window", () => {
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () =>
        scripted([
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed",
              rateLimitType: "five_hour",
              utilization: 0.25,
            },
          },
          rateLimitEvent,
          { type: "rate_limit_event" },
          ...[
            { rateLimitType: "seven_day" },
            { utilization: 0.9 },
            { rateLimitType: "overage", utilization: 0.9 },
            { rateLimitType: "future_window", utilization: 0.9 },
            { rateLimitType: "five_hour", utilization: -1 },
            { rateLimitType: "five_hour", utilization: "0.9" },
            { rateLimitType: "five_hour", utilization: 0.9, resetsAt: "tomorrow" },
            { rateLimitType: "five_hour", utilization: 0.9, resetsAt: 1e20 },
            { rateLimitType: "five_hour", utilization: 1e308 },
          ].map((info) => ({
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed_warning", ...info },
          })),
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed",
              rateLimitType: "seven_day",
              utilization: 0.5,
              extra_vendor_field: true,
            },
          },
          { type: "result", subtype: "success", result: "Done" },
        ]),
    });
    return Effect.gen(function* () {
      const session = yield* (yield* ChildBackend).launch(request());
      const [events, result] = yield* Effect.all([
        Stream.runCollect(session.events),
        session.result,
      ]);
      assert.strictEqual(result.message, "Done");
      const reports = events.filter(Schema.is(PoolRateLimitsUpdated));
      assert.lengthOf(reports, 2);
      const latest = reports.at(-1);
      assert(latest !== undefined);
      const snapshot = yield* Schema.encodeEffect(RateLimitsSnapshot)(latest.rateLimits);
      assert.deepStrictEqual(snapshot, {
        limitId: null,
        limitName: null,
        primary: null,
        secondary: { usedPercent: 50, windowDurationMinutes: 10_080, resetsAt: null },
      });
    }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk))), Effect.scoped);
  });

  for (const gatewayCredential of [Option.none(), Option.some("api-key" as const)]) {
    it.effect(
      `attributes ${Option.isSome(gatewayCredential) ? "gateway" : "local"} API-key usage to the API keys pool`,
      () => {
        const sdk = Layer.succeed(ClaudeSdk)({
          open: () => ({
            ...scripted([
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "allowed_warning",
                  rateLimitType: "five_hour",
                  utilization: 0.9,
                  resetsAt: 1_793_836_800,
                },
              },
              {
                type: "result",
                modelUsage: {
                  "claude-sonnet-4-6": {
                    inputTokens: 5,
                    outputTokens: 10,
                    cacheCreationInputTokens: 0,
                    costUSD: 0.01,
                  },
                },
                subtype: "success",
                result: "Done",
              },
            ]),
            usesApiKey: () => Promise.resolve(true),
          }),
        });
        return Effect.gen(function* () {
          const original = request();
          const session = yield* (yield* ChildBackend).launch(
            ChildRequest.make({
              ...original,
              session: ChildSession.make({
                ...original.session,
                gatewayCredential,
              }),
            }),
          );
          const [events, result] = yield* Effect.all([
            Stream.runCollect(session.events),
            session.result,
          ]);
          assert.strictEqual(result.message, "Done");
          assert.deepStrictEqual(session.session.pool, Option.some("apiKeys"));
          assert(events.some((event) => event._tag === "SessionTokensUpdated"));
          for (const event of events) assert.strictEqual(sessionPool(event.session), "apiKeys");
          assert.lengthOf(events.filter(Schema.is(PoolRateLimitsUpdated)), 0);
        }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk))), Effect.scoped);
      },
    );
  }

  it.effect(
    "persists its assigned session before input and acknowledges identical guidance by UUID",
    () =>
      Effect.gen(function* () {
        const inputs = yield* Queue.make<ClaudeUserMessage>();
        const output = yield* Queue.make<Schema.Json, Cause.Done>();
        const receipts = yield* Queue.make<string>();
        let saved = Option.none<HarnessSession>();
        const sdk = Layer.succeed(ClaudeSdk)({
          open: (input, options) => {
            assert(Option.isSome(saved), "the native reference is committed before SDK startup");
            assert.strictEqual(options.sessionId, saved.value.id);
            assert.match(options.sessionId ?? "", /^[0-9a-f-]{36}$/u);
            void (async () => {
              let first = true;
              for await (const message of input) {
                Queue.offerUnsafe(inputs, message);
                if (first) {
                  first = false;
                  Queue.offerUnsafe(output, rateLimitEvent);
                }
              }
            })();
            return {
              ...scripted([]),
              close: () => {
                Queue.endUnsafe(output);
              },
              [Symbol.asyncIterator]: () =>
                Stream.toAsyncIterable(Stream.fromQueue(output))[Symbol.asyncIterator](),
            };
          },
        });
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(request());
          yield* Queue.take(inputs);
          const first = OperatorMessage.make({ message: "Review the diff" });
          const second = OperatorMessage.make({ message: "Review the diff" });
          assert.notStrictEqual(first.id, second.id);
          for (const action of [first, second]) {
            const state = yield* running.intervene(action, (delivery) =>
              Option.isSome(delivery)
                ? Queue.offer(receipts, action.id).pipe(Effect.asVoid)
                : Effect.void,
            );
            assert.isTrue(state.queued);
            const sent = yield* Queue.take(inputs);
            assert.strictEqual(sent.uuid, action.id);
          }
          yield* Queue.offer(output, { type: "assistant", user_message_uuids: [second.id] });
          const secondReceipt = yield* Queue.take(receipts);
          assert.strictEqual(
            secondReceipt,
            second.id,
            "receipt order follows IDs, not queue position",
          );
          yield* Queue.offer(output, {
            type: "assistant",
            user_message_uuids: [second.id, first.id],
          });
          const firstReceipt = yield* Queue.take(receipts);
          assert.strictEqual(firstReceipt, first.id);
          yield* Queue.offer(output, { type: "result", subtype: "success", result: "Done" });
          yield* running.intervene(Release.make(), noDelivery);
          assert.strictEqual((yield* running.result).message, "Done");
          const duplicate = yield* Queue.clear(receipts);
          assert.deepStrictEqual(duplicate, []);
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk))),
          Effect.provideService(ChildSessionJournal, {
            started: (reference) =>
              Effect.sync(() => {
                saved = Option.some(reference);
              }),
            prompted: Effect.void,
            continued: () => Effect.void,
            delivered: () => Effect.void,
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.live("checkpoints a message only after the session has handled it", () =>
    Effect.gen(function* () {
      const stdout = (messages: ReadonlyArray<Schema.Json>) =>
        Effect.forEach(messages, jsonLine).pipe(
          Effect.map((lines) => Buffer.concat(lines).toString("base64")),
        );
      const { spawner, saved, frame } = yield* scriptedOwner(
        [
          { offset: 10, ready: true, sequence: 0, retained: false },
          {
            offset: 20,
            stdout: yield* stdout([
              { type: "system", subtype: "init", session_id: "claude-session-1" },
              rateLimitEvent,
            ]),
          },
        ],
        () => Effect.void,
      );
      const sdk = Layer.succeed(ClaudeSdk)({
        open: (_input, options) => {
          assert(options.spawnClaudeCodeProcess !== undefined);
          const child = options.spawnClaudeCodeProcess({
            command: "claude",
            args: [],
            env: {},
            signal: new AbortController().signal,
          });
          const lines = createInterface({ input: child.stdout });
          return {
            ...scripted([]),
            close: () => lines.close(),
            async *[Symbol.asyncIterator]() {
              for await (const line of lines) yield decodeStdoutLine(line);
            },
          };
        },
      });
      const stopping = yield* Ref.make(false);
      const scope = yield* Scope.make();
      const handling = yield* Deferred.make<void>();
      const guidance = OperatorMessage.make({ message: "Review the diff" });
      const worker = RemoteShell.make({
        ssh: { command: "ssh", args: [] },
        sshEnvironment: {},
        destination: "worker",
      });
      const running = yield* ChildBackend.pipe(
        Effect.flatMap((backend) => backend.launch(request(undefined, undefined, worker))),
        Effect.provide(
          claudeChildWith(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)).pipe(
            Layer.provideMerge(sdk),
          ),
        ),
        Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
        Scope.provide(scope),
      );
      // The session is still handling the receipt while the owner detaches.
      yield* running.intervene(guidance, (delivery) =>
        Option.isSome(delivery)
          ? Deferred.succeed(handling, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      );
      yield* frame({
        offset: 30,
        stdout: yield* stdout([
          { type: "assistant", uuid: "receipt", user_message_uuids: [guidance.id] },
        ]),
      });
      yield* Deferred.await(handling);
      yield* Ref.set(stopping, true);
      yield* Scope.close(scope, Exit.void);
      const cursor = yield* Deferred.await(saved).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(cursor, { offset: 20, skip: 0 }, "the receipt is replayed");
    }),
  );

  it.effect("acknowledges folded guidance on a typed turn while leaving pending sends queued", () =>
    Effect.gen(function* () {
      const inputs = yield* Queue.make<ClaudeUserMessage>();
      const output = yield* Queue.make<Schema.Json, Cause.Done>();
      const idle = yield* Deferred.make<void>();
      const receipts = yield* Queue.make<string>();
      const sdk = Layer.succeed(ClaudeSdk)({
        open: (input) => {
          void (async () => {
            for await (const message of input) {
              Queue.offerUnsafe(inputs, message);
              Queue.offerUnsafe(output, rateLimitEvent);
            }
          })();
          return {
            ...scripted([]),
            close: () => Queue.endUnsafe(output),
            [Symbol.asyncIterator]: () =>
              Stream.toAsyncIterable(Stream.fromQueue(output))[Symbol.asyncIterator](),
          };
        },
      });
      yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(
          ChildRequest.make({ ...request(), held: true }),
        );
        yield* Effect.forkScoped(
          running.events.pipe(
            Stream.runForEach((event) =>
              event._tag === "SessionIdle" ? Deferred.succeed(idle, undefined) : Effect.void,
            ),
          ),
        );
        yield* Queue.take(inputs);
        yield* Queue.offer(output, {
          type: "result",
          subtype: "success",
          result: "Waiting",
          queued_turn_count: 0,
        });
        yield* Deferred.await(idle);
        const first = OperatorMessage.make({ message: "Start the correction" });
        const folded = OperatorMessage.make({ message: "Review the diff" });
        const pending = OperatorMessage.make({ message: "Review the diff" });
        const send = (action: OperatorMessage) =>
          running.intervene(action, (delivery) =>
            Queue.offer(receipts, Option.isSome(delivery) ? action.id : "unread").pipe(
              Effect.asVoid,
            ),
          );
        yield* send(first);
        assert.strictEqual((yield* Queue.take(inputs)).uuid, first.id);
        yield* Queue.offer(output, { type: "assistant", user_message_uuids: [first.id] });
        const firstReceipt = yield* Queue.take(receipts);
        assert.strictEqual(firstReceipt, first.id);
        for (const action of [folded, pending]) {
          yield* send(action);
          assert.strictEqual((yield* Queue.take(inputs)).uuid, action.id);
        }
        // Typed-prompt turns do not stamp another assistant frame after folding guidance.
        yield* Queue.offer(output, {
          type: "assistant",
          message: { content: [{ type: "text", text: "Corrected" }] },
        });
        yield* Queue.offer(output, {
          type: "result",
          subtype: "success",
          result: "Corrected",
          queued_turn_count: 1,
        });
        const foldedReceipt = yield* Queue.take(receipts);
        assert.strictEqual(foldedReceipt, folded.id);
        const extraReceipts = yield* Queue.clear(receipts);
        assert.deepStrictEqual(extraReceipts, []);
        yield* Queue.offer(output, {
          type: "result",
          subtype: "success",
          result: "Reviewed",
          queued_turn_count: 0,
        });
        const pendingReceipt = yield* Queue.take(receipts);
        assert.strictEqual(pendingReceipt, pending.id);
        yield* running.intervene(Release.make(), noDelivery);
        assert.strictEqual((yield* running.result).message, "Reviewed");
        const finalReceipts = yield* Queue.clear(receipts);
        assert.deepStrictEqual(finalReceipts, []);
      }).pipe(Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps guidance unread when the result's receipts leave it out", () =>
    Effect.gen(function* () {
      const inputs = yield* Queue.make<ClaudeUserMessage>();
      const output = yield* Queue.make<Schema.Json, Cause.Done>();
      const idle = yield* Queue.make<void>();
      const receipts = yield* Queue.make<string>();
      const sdk = Layer.succeed(ClaudeSdk)({
        open: (input) => {
          void (async () => {
            for await (const message of input) {
              Queue.offerUnsafe(inputs, message);
              Queue.offerUnsafe(output, rateLimitEvent);
            }
          })();
          return {
            ...scripted([]),
            close: () => Queue.endUnsafe(output),
            [Symbol.asyncIterator]: () =>
              Stream.toAsyncIterable(Stream.fromQueue(output))[Symbol.asyncIterator](),
          };
        },
      });
      yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(
          ChildRequest.make({ ...request(), held: true }),
        );
        yield* Effect.forkScoped(
          running.events.pipe(
            Stream.runForEach((event) =>
              event._tag === "SessionIdle" ? Queue.offer(idle, undefined) : Effect.void,
            ),
          ),
        );
        yield* Queue.take(inputs);
        yield* Queue.offer(output, {
          type: "result",
          subtype: "success",
          result: "Waiting",
          queued_turn_count: 0,
        });
        yield* Queue.take(idle);
        const read = OperatorMessage.make({ message: "Start the correction" });
        const inTransit = Steer.make({ message: "Also check the tests" });
        for (const action of [read, inTransit]) {
          yield* running.intervene(action, (delivery) =>
            Queue.offer(receipts, Option.isSome(delivery) ? action.id : "unread").pipe(
              Effect.asVoid,
            ),
          );
          const sent = yield* Queue.take(inputs);
          assert.strictEqual(sent.uuid, action.id);
        }
        // The steer reached Claude after it wrote this result, which names only the first message.
        yield* Queue.offer(output, {
          type: "result",
          subtype: "success",
          result: "Corrected",
          queued_turn_count: 0,
          user_message_uuids: [read.id],
        });
        const readReceipt = yield* Queue.take(receipts);
        assert.strictEqual(readReceipt, read.id);
        yield* Queue.take(idle);
        const early = yield* Queue.clear(receipts);
        assert.deepStrictEqual(early, []);
        yield* running.intervene(Release.make(), noDelivery);
        assert.strictEqual((yield* running.result).message, "Corrected");
      }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
      const unread = yield* Queue.clear(receipts);
      assert.deepStrictEqual(unread, ["unread"]);
    }).pipe(Effect.scoped),
  );

  /** A Claude SDK whose output the test writes, and the user messages that the harness sent. */
  const typedTurnSdk = Effect.gen(function* () {
    const inputs = yield* Queue.make<ClaudeUserMessage>();
    const output = yield* Queue.make<Schema.Json, Cause.Done>();
    const sdk = Layer.succeed(ClaudeSdk)({
      open: (input) => {
        void (async () => {
          for await (const message of input) {
            Queue.offerUnsafe(inputs, message);
            Queue.offerUnsafe(output, rateLimitEvent);
          }
        })();
        return {
          ...scripted([]),
          close: () => Queue.endUnsafe(output),
          [Symbol.asyncIterator]: () =>
            Stream.toAsyncIterable(Stream.fromQueue(output))[Symbol.asyncIterator](),
        };
      },
    });
    return { inputs, output, sdk };
  });

  // Claude folds a message queued during a typed turn in between tool rounds, and names it only on
  // the turn's result: in `user_message_uuids`, or through `queued_turn_count` on older versions.
  for (const { name, steps, answered } of [
    {
      name: "counts a steer sent while the model generates a tool call, with no later tool",
      steps: ["steer", "use:bash-1", "result:bash-1"],
      answered: true,
    },
    {
      name: "counts a steer sent while a tool runs, with no later tool",
      steps: ["use:bash-1", "steer", "result:bash-1"],
      answered: true,
    },
    {
      name: "counts a steer sent after an earlier tool round, folded in at the next one",
      steps: ["use:bash-1", "result:bash-1", "steer", "use:bash-2", "result:bash-2"],
      answered: true,
    },
    {
      name: "doesn't count a steer folded in before a later tool call",
      steps: ["steer", "use:bash-1", "result:bash-1", "use:bash-2", "result:bash-2"],
      answered: false,
    },
    {
      name: "counts a steer that a typed turn acknowledged with no tool call",
      steps: ["steer"],
      answered: true,
    },
    {
      name: "reads several steers of one turn at the latest point that it folded one in",
      steps: ["steer", "use:bash-1", "result:bash-1", "steer", "use:bash-2", "result:bash-2"],
      answered: true,
    },
    {
      name: "doesn't count several steers of one turn when a tool call follows the last fold",
      steps: [
        "steer",
        "use:bash-1",
        "result:bash-1",
        "steer",
        "use:bash-2",
        "result:bash-2",
        "use:bash-3",
        "result:bash-3",
      ],
      answered: false,
    },
  ])
    for (const acknowledgement of ["user_message_uuids", "queued_turn_count"] as const)
      it.effect(`${name}, acknowledged by ${acknowledgement}`, () =>
        Effect.gen(function* () {
          const { inputs, output, sdk } = yield* typedTurnSdk;
          const result = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(request());
            const events = yield* Queue.unbounded<string>();
            yield* Effect.forkScoped(
              running.events.pipe(Stream.runForEach((event) => Queue.offer(events, event._tag))),
            );
            const until = (tag: string): Effect.Effect<void> =>
              Queue.take(events).pipe(
                Effect.flatMap((taken) => (taken === tag ? Effect.void : until(tag))),
              );
            yield* Queue.take(inputs);
            const steers: Array<Steer> = [];
            for (const step of steps) {
              const [kind, id = ""] = step.split(":");
              if (kind === "steer") {
                const steer = Steer.make({ message: `Check step ${steers.length + 1}` });
                steers.push(steer);
                yield* running.intervene(steer, noDelivery);
                yield* Queue.take(inputs);
              } else if (kind === "use") {
                yield* Queue.offer(output, {
                  type: "assistant",
                  message: {
                    content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
                  },
                });
                yield* until("ToolStarted");
              } else {
                yield* Queue.offer(output, {
                  type: "user",
                  message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
                });
                yield* until("ToolFinished");
              }
            }
            const result = {
              type: "result",
              subtype: "success",
              result: "Done",
              queued_turn_count: 0,
            };
            yield* Queue.offer(
              output,
              acknowledgement === "user_message_uuids"
                ? { ...result, user_message_uuids: steers.map(({ id }) => id) }
                : result,
            );
            return yield* running.result;
          }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
          assert.strictEqual(result.message, "Done");
          assert.strictEqual(result.answeredOperator, answered);
        }).pipe(Effect.scoped),
      );

  // Claude runs a message that arrives after a turn's last tool round as a turn of its own. The
  // first result leaves it queued, and the next turn reads it before any of its tool calls.
  for (const { name, tool, answered } of [
    {
      name: "doesn't count a steer run as its own turn when that turn calls a tool",
      tool: true,
      answered: false,
    },
    {
      name: "counts a steer run as its own turn when that turn calls no tool",
      tool: false,
      answered: true,
    },
  ])
    for (const acknowledgement of ["user_message_uuids", "queued_turn_count"] as const)
      it.effect(`${name}, acknowledged by ${acknowledgement}`, () =>
        Effect.gen(function* () {
          const { inputs, output, sdk } = yield* typedTurnSdk;
          const result = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(request());
            const events = yield* Queue.unbounded<string>();
            yield* Effect.forkScoped(
              running.events.pipe(Stream.runForEach((event) => Queue.offer(events, event._tag))),
            );
            const until = (tag: string): Effect.Effect<void> =>
              Queue.take(events).pipe(
                Effect.flatMap((taken) => (taken === tag ? Effect.void : until(tag))),
              );
            const toolRound = (id: string) =>
              Effect.gen(function* () {
                yield* Queue.offer(output, {
                  type: "assistant",
                  message: {
                    content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
                  },
                });
                yield* until("ToolStarted");
                yield* Queue.offer(output, {
                  type: "user",
                  message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
                });
                yield* until("ToolFinished");
              });
            yield* Queue.take(inputs);
            yield* toolRound("bash-1");
            const steer = Steer.make({ message: "Check the logs" });
            yield* running.intervene(steer, noDelivery);
            yield* Queue.take(inputs);
            yield* Queue.offer(output, {
              type: "result",
              subtype: "success",
              result: "Started",
              queued_turn_count: 1,
            });
            const acknowledged =
              acknowledgement === "user_message_uuids" ? { user_message_uuids: [steer.id] } : {};
            yield* Queue.offer(output, {
              type: "assistant",
              message: { content: [{ type: "text", text: "Checking the logs" }] },
              ...acknowledged,
            });
            if (tool) yield* toolRound("bash-2");
            yield* Queue.offer(output, {
              type: "result",
              subtype: "success",
              result: "Done",
              queued_turn_count: 0,
              ...acknowledged,
            });
            return yield* running.result;
          }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
          assert.strictEqual(result.message, "Done");
          assert.strictEqual(result.answeredOperator, answered);
        }).pipe(Effect.scoped),
      );

  /** Records `running`'s event tags, and writes tool rounds to `output` once the harness handled them. */
  const turnDriver = (
    running: { readonly events: Stream.Stream<{ readonly _tag: string }, unknown> },
    output: () => Queue.Queue<Schema.Json, Cause.Done>,
  ) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<string>();
      yield* Effect.forkScoped(
        running.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event._tag)),
          Effect.ignore,
        ),
      );
      const until = (tag: string): Effect.Effect<void> =>
        Queue.take(events).pipe(
          Effect.flatMap((taken) => (taken === tag ? Effect.void : until(tag))),
        );
      const toolRound = (id: string) =>
        Effect.gen(function* () {
          yield* Queue.offer(output(), {
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
            },
          });
          yield* until("ToolStarted");
          yield* Queue.offer(output(), {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
          });
          yield* until("ToolFinished");
        });
      return { until, toolRound };
    });

  // Claude doesn't fold in a message sent while no turn runs: the message starts the next turn,
  // which reads it before any of its tool calls.
  for (const followUp of ["Steer", "OperatorMessage"] as const)
    for (const tool of [true, false])
      for (const acknowledgement of ["user_message_uuids", "queued_turn_count"] as const)
        it.effect(
          `${tool ? "doesn't count" : "counts"} a ${followUp} to an idle held child whose turn ${tool ? "calls a tool" : "calls no tool"}, acknowledged by ${acknowledgement}`,
          () =>
            Effect.gen(function* () {
              const { inputs, output, sdk } = yield* typedTurnSdk;
              const result = yield* Effect.gen(function* () {
                const running = yield* (yield* ChildBackend).launch(request());
                const { until, toolRound } = yield* turnDriver(running, () => output);
                const acknowledged = (ids: ReadonlyArray<string>) =>
                  acknowledgement === "user_message_uuids" ? { user_message_uuids: ids } : {};
                yield* Queue.take(inputs);
                yield* toolRound("bash-1");
                const question = OperatorMessage.make({ message: "Why did the build fail?" });
                yield* running.intervene(question, noDelivery);
                yield* Queue.take(inputs);
                yield* Queue.offer(output, {
                  type: "result",
                  subtype: "success",
                  result: "The cache is stale.",
                  queued_turn_count: 0,
                  ...acknowledged([question.id]),
                });
                yield* until("SessionIdle");
                const next =
                  followUp === "Steer"
                    ? Steer.make({ message: "Clear the cache" })
                    : OperatorMessage.make({ message: "Clear the cache" });
                yield* running.intervene(next, noDelivery);
                yield* Queue.take(inputs);
                yield* Queue.offer(output, {
                  type: "assistant",
                  message: { content: [{ type: "text", text: "Clearing the cache" }] },
                  ...acknowledged([next.id]),
                });
                if (tool) yield* toolRound("bash-2");
                yield* Queue.offer(output, {
                  type: "result",
                  subtype: "success",
                  result: "Done",
                  queued_turn_count: 0,
                  ...acknowledged([next.id]),
                });
                yield* until("SessionIdle");
                yield* running.intervene(Release.make(), noDelivery);
                return yield* running.result;
              }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
              assert.strictEqual(result.message, "Done");
              assert.strictEqual(result.answeredOperator, !tool);
            }).pipe(Effect.scoped),
        );

  for (const acknowledgement of ["user_message_uuids", "queued_turn_count"] as const)
    it.effect(
      `doesn't count a message to a child restored idle when its turn calls a tool, acknowledged by ${acknowledgement}`,
      () =>
        Effect.gen(function* () {
          const { inputs, output, sdk } = yield* typedTurnSdk;
          const result = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(),
                held: true,
                idle: Option.some("The tests need a database."),
                idleAnsweredOperator: false,
              }),
            );
            const { until, toolRound } = yield* turnDriver(running, () => output);
            const question = OperatorMessage.make({ message: "Start one" });
            const acknowledged =
              acknowledgement === "user_message_uuids" ? { user_message_uuids: [question.id] } : {};
            yield* running.intervene(question, noDelivery);
            yield* Queue.take(inputs);
            yield* Queue.offer(output, {
              type: "assistant",
              message: { content: [{ type: "text", text: "Starting a database" }] },
              ...acknowledged,
            });
            yield* toolRound("bash-1");
            yield* Queue.offer(output, {
              type: "result",
              subtype: "success",
              result: "Done",
              queued_turn_count: 0,
              ...acknowledged,
            });
            yield* until("SessionIdle");
            yield* running.intervene(Release.make(), noDelivery);
            return yield* running.result;
          }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
          assert.strictEqual(result.message, "Done");
          assert.isFalse(result.answeredOperator);
        }).pipe(Effect.scoped),
    );

  // Once the turn that a message to an idle child started is running, Claude folds a later steer
  // into it at its next tool result.
  for (const acknowledgement of ["user_message_uuids", "queued_turn_count"] as const)
    it.effect(
      `counts a steer folded into the turn that a message to an idle child started, acknowledged by ${acknowledgement}`,
      () =>
        Effect.gen(function* () {
          const { inputs, output, sdk } = yield* typedTurnSdk;
          const result = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({ ...request(), held: true }),
            );
            const { until, toolRound } = yield* turnDriver(running, () => output);
            const acknowledged = (ids: ReadonlyArray<string>) =>
              acknowledgement === "user_message_uuids" ? { user_message_uuids: ids } : {};
            yield* Queue.take(inputs);
            yield* Queue.offer(output, {
              type: "result",
              subtype: "success",
              result: "Waiting",
              queued_turn_count: 0,
            });
            yield* until("SessionIdle");
            const question = OperatorMessage.make({ message: "Check the build" });
            yield* running.intervene(question, noDelivery);
            yield* Queue.take(inputs);
            yield* Queue.offer(output, {
              type: "assistant",
              message: { content: [{ type: "text", text: "Checking the build" }] },
              ...acknowledged([question.id]),
            });
            yield* until("TextOutput");
            // The model is generating its tool call, so Claude reads the steer at its result.
            const steer = Steer.make({ message: "Use the cached build" });
            yield* running.intervene(steer, noDelivery);
            yield* Queue.take(inputs);
            yield* toolRound("bash-1");
            yield* Queue.offer(output, {
              type: "result",
              subtype: "success",
              result: "Done",
              queued_turn_count: 0,
              ...acknowledged([question.id, steer.id]),
            });
            yield* until("SessionIdle");
            yield* running.intervene(Release.make(), noDelivery);
            return yield* running.result;
          }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
          assert.strictEqual(result.message, "Done");
          assert.isTrue(result.answeredOperator);
        }).pipe(Effect.scoped),
    );

  // A steer sent after a result that left an earlier steer queued joins that steer's turn.
  for (const tool of [true, false])
    for (const acknowledgement of ["user_message_uuids", "queued_turn_count"] as const)
      it.effect(
        `${tool ? "doesn't count" : "counts"} a steer sent after a result queued a turn, when that turn ${tool ? "calls a tool" : "calls no tool"}, acknowledged by ${acknowledgement}`,
        () =>
          Effect.gen(function* () {
            const { inputs, output, sdk } = yield* typedTurnSdk;
            const logs = infoLines();
            const result = yield* Effect.gen(function* () {
              const running = yield* (yield* ChildBackend).launch(request());
              const { toolRound } = yield* turnDriver(running, () => output);
              yield* Queue.take(inputs);
              yield* toolRound("bash-1");
              const first = Steer.make({ message: "Check the logs" });
              yield* running.intervene(first, noDelivery);
              yield* Queue.take(inputs);
              yield* Queue.offer(output, {
                type: "result",
                subtype: "success",
                result: "Started",
                queued_turn_count: 1,
              });
              while (
                !logs.lines.some((line) => line.includes("Claude child has queued user turns"))
              )
                yield* Effect.yieldNow;
              const second = Steer.make({ message: "And the metrics" });
              yield* running.intervene(second, noDelivery);
              yield* Queue.take(inputs);
              const acknowledged =
                acknowledgement === "user_message_uuids"
                  ? { user_message_uuids: [first.id, second.id] }
                  : {};
              yield* Queue.offer(output, {
                type: "assistant",
                message: { content: [{ type: "text", text: "Checking both" }] },
                ...acknowledged,
              });
              if (tool) yield* toolRound("bash-2");
              yield* Queue.offer(output, {
                type: "result",
                subtype: "success",
                result: "Done",
                queued_turn_count: 0,
                ...acknowledged,
              });
              return yield* running.result;
            }).pipe(
              Effect.scoped,
              Effect.provide(claudeChild.pipe(Layer.provide(sdk), Layer.provideMerge(logs.layer))),
            );
            assert.strictEqual(result.message, "Done");
            assert.strictEqual(result.answeredOperator, !tool);
          }).pipe(Effect.scoped),
      );

  // After a lost remote process, recovery resends the unread steer with its continuation, and the
  // resumed process runs them as a new turn that reads the steer before its tool calls.
  for (const tool of [true, false])
    it.effect(
      `${tool ? "doesn't count" : "counts"} a steer resent after a resume when the resumed turn ${tool ? "calls a tool" : "calls no tool"}`,
      () =>
        Effect.gen(function* () {
          const inputs = yield* Queue.make<ClaudeUserMessage>();
          const outputs: Array<Queue.Queue<Schema.Json, Cause.Done>> = [];
          const resumes: Array<string | undefined> = [];
          const lost = { type: "test_process_lost" };
          const context = yield* Effect.context<never>();
          const sdk = Layer.succeed(ClaudeSdk)({
            open: (input, options) => {
              const output = Effect.runSyncWith(context)(Queue.make<Schema.Json, Cause.Done>());
              outputs.push(output);
              resumes.push(options.resume);
              void (async () => {
                for await (const message of input) {
                  Queue.offerUnsafe(inputs, message);
                  Queue.offerUnsafe(output, rateLimitEvent);
                }
              })();
              return {
                ...scripted([]),
                close: () => Queue.endUnsafe(output),
                async *[Symbol.asyncIterator]() {
                  for (;;) {
                    const next = await Effect.runPromiseWith(context)(
                      Effect.option(Queue.take(output)),
                    );
                    if (Option.isNone(next)) return;
                    if (next.value === lost)
                      throw ChildProcessLost.make({ exitCode: 255, stderrTail: "" });
                    yield next.value;
                  }
                },
              };
            },
          });
          const result = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              request(undefined, undefined, exitingHost(0)),
            );
            const output = () => outputs.at(-1)!;
            const { toolRound } = yield* turnDriver(running, output);
            yield* Queue.take(inputs);
            yield* toolRound("bash-1");
            const steer = Steer.make({ message: "Check the logs" });
            yield* running.intervene(steer, noDelivery);
            yield* Queue.take(inputs);
            yield* Queue.offer(output(), {
              type: "result",
              subtype: "success",
              result: "Started",
              queued_turn_count: 1,
            });
            // The queued turn starts, and the process stops before its result names the steer.
            yield* Queue.offer(output(), {
              type: "assistant",
              message: { content: [{ type: "text", text: "Checking the logs" }] },
            });
            yield* Queue.offer(output(), lost);
            yield* Queue.take(inputs);
            const resent = yield* Queue.take(inputs);
            assert.strictEqual(resent.uuid, steer.id);
            assert.lengthOf(outputs, 2);
            assert.isDefined(resumes[1]);
            yield* Queue.offer(output(), {
              type: "assistant",
              message: { content: [{ type: "text", text: "Checking the logs again" }] },
            });
            if (tool) yield* toolRound("bash-2");
            yield* Queue.offer(output(), {
              type: "result",
              subtype: "success",
              result: "Done",
              queued_turn_count: 0,
            });
            return yield* running.result;
          }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
          assert.strictEqual(result.message, "Done");
          assert.strictEqual(result.answeredOperator, !tool);
        }).pipe(Effect.scoped),
    );

  it.effect(
    "leaves a steer unread when it reaches Claude after the result that names the task",
    () =>
      Effect.gen(function* () {
        const { inputs, output, sdk } = yield* typedTurnSdk;
        const receipts = yield* Queue.unbounded<string>();
        const result = yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(request());
          const { toolRound } = yield* turnDriver(running, () => output);
          const task = (yield* Queue.take(inputs)).uuid;
          assert(Schema.is(OperatorMessageId)(task), "the task carries a client UUID");
          yield* toolRound("bash-1");
          // Claude has produced the result when the steer arrives, so it queues no turn for it.
          const steer = Steer.make({ message: "Check the logs" });
          yield* running.intervene(steer, (delivery) =>
            Queue.offer(receipts, Option.isSome(delivery) ? "read" : "unread").pipe(Effect.asVoid),
          );
          yield* Queue.take(inputs);
          yield* Queue.offer(output, {
            type: "result",
            subtype: "success",
            result: "Done",
            queued_turn_count: 0,
            user_message_uuids: [task],
          });
          return yield* running.result;
        }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
        assert.strictEqual(result.message, "Done");
        assert.isFalse(result.answeredOperator);
        const delivered = yield* Queue.clear(receipts);
        assert.deepStrictEqual(delivered, ["unread"]);
      }).pipe(Effect.scoped),
  );

  // The first frame of a turn names the messages that the turn started with. A message that it
  // leaves out reached Claude after the turn started, so Claude folds it in at a tool result.
  for (const tool of [true, false])
    it.effect(
      `${tool ? "doesn't count" : "counts"} a steer that a turn's first frame leaves out when ${tool ? "a tool call follows" : "no tool call follows"} its fold`,
      () =>
        Effect.gen(function* () {
          const { inputs, output, sdk } = yield* typedTurnSdk;
          const result = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({ ...request(), held: true }),
            );
            const { until, toolRound } = yield* turnDriver(running, () => output);
            yield* Queue.take(inputs);
            yield* Queue.offer(output, {
              type: "result",
              subtype: "success",
              result: "Waiting",
              queued_turn_count: 0,
            });
            yield* until("SessionIdle");
            const question = OperatorMessage.make({ message: "Check the build" });
            const steer = Steer.make({ message: "Use the cached build" });
            // Both reach the harness before the first frame of the turn that the question starts.
            for (const action of [question, steer]) {
              yield* running.intervene(action, noDelivery);
              yield* Queue.take(inputs);
            }
            yield* Queue.offer(output, {
              type: "assistant",
              message: { content: [{ type: "text", text: "Checking the build" }] },
              user_message_uuids: [question.id],
            });
            yield* toolRound("bash-1");
            if (tool) yield* toolRound("bash-2");
            yield* Queue.offer(output, {
              type: "result",
              subtype: "success",
              result: "Done",
              queued_turn_count: 0,
              user_message_uuids: [question.id, steer.id],
            });
            yield* until("SessionIdle");
            yield* running.intervene(Release.make(), noDelivery);
            return yield* running.result;
          }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
          assert.strictEqual(result.message, "Done");
          assert.strictEqual(result.answeredOperator, !tool);
        }).pipe(Effect.scoped),
    );

  // A resumed saved session runs no turn until recovery sends one, so Claude reads a resent steer
  // when the turn that it starts with the continuation begins.
  for (const tool of [true, false])
    it.effect(
      `${tool ? "doesn't count" : "counts"} a steer resent to a resumed saved session when the turn ${tool ? "calls a tool" : "calls no tool"}`,
      () =>
        Effect.gen(function* () {
          const { inputs, output, sdk } = yield* typedTurnSdk;
          const steer = Steer.make({ message: "Check the logs" });
          const result = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(),
                resume: Option.some(HarnessSession.make({ cwd: request().cwd })),
                unread: [{ id: steer.id, message: steer.message }],
              }),
            );
            const { toolRound } = yield* turnDriver(running, () => output);
            const continuation = yield* Queue.take(inputs);
            assert.isTrue(Schema.is(OperatorMessageId)(continuation.uuid));
            assert.notStrictEqual(continuation.uuid, steer.id);
            assert.strictEqual((yield* Queue.take(inputs)).uuid, steer.id);
            yield* Queue.offer(output, {
              type: "assistant",
              message: { content: [{ type: "text", text: "Checking the logs" }] },
            });
            if (tool) yield* toolRound("bash-1");
            yield* Queue.offer(output, {
              type: "result",
              subtype: "success",
              result: "Done",
              queued_turn_count: 0,
            });
            return yield* running.result;
          }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
          assert.strictEqual(result.message, "Done");
          assert.strictEqual(result.answeredOperator, !tool);
        }).pipe(Effect.scoped),
    );

  /**
   * A Claude SDK whose remote process owner reports a retained process, with output that the test
   * writes, and the user messages that the harness sent.
   */
  const retainedSdk = Effect.gen(function* () {
    const inputs = yield* Queue.make<ClaudeUserMessage>();
    const output = yield* Queue.make<Schema.Json, Cause.Done>();
    const init = yield* jsonLine({ type: "system", subtype: "init", session_id: "saved-claude" });
    const { spawner } = yield* scriptedOwner(
      [
        { offset: 10, ready: true, sequence: 0, retained: true },
        { offset: 20, stdout: init.toString("base64") },
      ],
      () => Effect.void,
    );
    const sdk = Layer.succeed(ClaudeSdk)({
      open: (input, options) => {
        assert(options.spawnClaudeCodeProcess !== undefined);
        const child = options.spawnClaudeCodeProcess({
          command: "claude",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        const lines = createInterface({ input: child.stdout });
        // The owner reports whether it retained the process before it relays any output.
        const reattached = new Promise<void>((resolve) => lines.once("line", () => resolve()));
        void (async () => {
          for await (const message of input) Queue.offerUnsafe(inputs, message);
        })();
        return {
          ...scripted([]),
          supportedModels: async () => {
            await reattached;
            return [{ value: "sonnet", resolvedModel: "claude-sonnet-4-6" }];
          },
          close: () => {
            lines.close();
            Queue.endUnsafe(output);
          },
          [Symbol.asyncIterator]: () =>
            Stream.toAsyncIterable(Stream.fromQueue(output))[Symbol.asyncIterator](),
        };
      },
    });
    // Other commands on the Worker, such as the owner's stop, succeed.
    const commands = workerCommands(0).layer;
    const owner = ChildProcessSpawner.make((command) =>
      command._tag === "StandardCommand" && Predicate.hasProperty(command.options.stdin, "stream")
        ? spawner.spawn(command)
        : ChildProcessSpawner.ChildProcessSpawner.pipe(
            Effect.flatMap((other) => other.spawn(command)),
            Effect.provide(commands),
          ),
    );
    const layer = claudeChildWith(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(owner),
    ).pipe(Layer.provideMerge(sdk));
    return { inputs, output, layer };
  });

  /** A request that reattaches the retained process of the saved session `saved-claude`. */
  const reattach = (fields: Partial<Parameters<typeof ChildRequest.make>[0]> = {}) => {
    const original = request(undefined, undefined, scriptedTarget.host);
    return ChildRequest.make({
      ...original,
      resume: Option.some(
        HarnessSession.make({ id: HarnessSessionId.make("saved-claude"), cwd: original.cwd }),
      ),
      ...fields,
    });
  };

  // A reattached process that runs its task is inside a turn, so Claude folds a steer in at the
  // next tool result.
  it.live("counts a steer folded into the turn of a reattached running process", () =>
    Effect.gen(function* () {
      const { inputs, output, layer } = yield* retainedSdk;
      const result = yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(reattach());
        const { toolRound } = yield* turnDriver(running, () => output);
        const steer = Steer.make({ message: "Check the logs" });
        yield* running.intervene(steer, noDelivery);
        assert.strictEqual((yield* Queue.take(inputs)).uuid, steer.id);
        yield* toolRound("bash-1");
        yield* Queue.offer(output, {
          type: "result",
          subtype: "success",
          result: "Done",
          queued_turn_count: 0,
        });
        return yield* running.result;
      }).pipe(Effect.scoped, Effect.provide(layer));
      assert.strictEqual(result.message, "Done");
      assert.isTrue(result.answeredOperator);
    }).pipe(Effect.scoped),
  );

  // A reattached process that never got its task, or that waits idle under a Hold, runs no turn, so
  // the next message starts one and Claude reads it before the turn's tool calls.
  for (const restored of ["unprompted", "idle"] as const)
    for (const tool of [true, false])
      it.live(
        `${tool ? "doesn't count" : "counts"} a message that starts the turn of a reattached ${restored} process when the turn ${tool ? "calls a tool" : "calls no tool"}`,
        () =>
          Effect.gen(function* () {
            const { inputs, output, layer } = yield* retainedSdk;
            const message = OperatorMessage.make({ message: "Check the logs" });
            const result = yield* Effect.gen(function* () {
              const running = yield* (yield* ChildBackend).launch(
                restored === "unprompted"
                  ? reattach({
                      prompted: false,
                      unread: [{ id: message.id, message: message.message }],
                    })
                  : reattach({ held: true, idle: Option.some("Waiting for the logs.") }),
              );
              const { until, toolRound } = yield* turnDriver(running, () => output);
              if (restored === "unprompted") {
                assert.strictEqual(
                  (yield* Queue.take(inputs)).message.content,
                  request().prompt,
                  "recovery sends the task first",
                );
              } else {
                yield* until("SessionIdle");
                yield* running.intervene(message, noDelivery);
              }
              assert.strictEqual((yield* Queue.take(inputs)).uuid, message.id);
              yield* Queue.offer(output, {
                type: "assistant",
                message: { content: [{ type: "text", text: "Checking the logs" }] },
              });
              if (tool) yield* toolRound("bash-1");
              yield* Queue.offer(output, {
                type: "result",
                subtype: "success",
                result: "Done",
                queued_turn_count: 0,
              });
              if (restored === "idle") {
                yield* until("SessionIdle");
                yield* running.intervene(Release.make(), noDelivery);
              }
              return yield* running.result;
            }).pipe(Effect.scoped, Effect.provide(layer));
            assert.strictEqual(result.message, "Done");
            assert.strictEqual(result.answeredOperator, !tool);
          }).pipe(Effect.scoped),
      );

  for (const answered of [true, false])
    it.effect(
      `restores whether a held idle report ${answered ? "answers" : "doesn't answer"} the operator`,
      () =>
        Effect.gen(function* () {
          const { sdk } = yield* typedTurnSdk;
          const result = yield* Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(
              ChildRequest.make({
                ...request(),
                held: true,
                idle: Option.some("The tests need a database."),
                idleAnsweredOperator: answered,
              }),
            );
            yield* running.intervene(Release.make(), noDelivery);
            return yield* running.result;
          }).pipe(Effect.scoped, Effect.provide(claudeChild.pipe(Layer.provide(sdk))));
          assert.strictEqual(result.message, "The tests need a database.");
          assert.strictEqual(result.answeredOperator, answered);
        }).pipe(Effect.scoped),
    );

  it.effect("launches again after Claude loses its login refresh lock and keeps that session", () =>
    Effect.gen(function* () {
      const { launches, sdk } = loginRace(1);
      const logs = infoLines();
      yield* Effect.gen(function* () {
        const launching = yield* Effect.forkChild(
          Effect.gen(function* () {
            return yield* (yield* ChildBackend).launch(request());
          }),
        );
        const session = yield* joinAdvancingClock(launching);
        const [events, result] = yield* Effect.all([
          Stream.runCollect(session.events),
          session.result,
        ]);
        assert.strictEqual(result.message, "Child completed the edit.");
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["SessionStarted", "TextOutput", "SessionFinished"],
          "the failed launch leaves nothing in the transcript",
        );
        const started = events[0];
        assert(started?._tag === "SessionStarted" && Option.isSome(started.harnessSession));
        assert.match(started.harnessSession.value.id, /^[0-9a-f-]{36}$/u);
        const assignedId = started.harnessSession.value.id;
        assert.deepStrictEqual(
          launches.map(({ id, resume }) => ({ id, resume })),
          [
            { id: assignedId, resume: undefined },
            { id: undefined, resume: assignedId },
          ],
        );
        assert.deepStrictEqual(
          launches.map(({ closed }) => closed),
          [true, false],
        );
        const retries = logs.lines.filter((line) => line.includes("launching it again"));
        assert.lengthOf(retries, 1);
        assert.include(retries[0], '"delay":"15s"');
      }).pipe(
        Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
        Effect.scoped,
      );
    }),
  );

  it.effect("returns Claude's login error to the parent once every launch lost the lock", () =>
    Effect.gen(function* () {
      const { launches, sdk } = loginRace(Number.POSITIVE_INFINITY);
      const logs = infoLines();
      yield* Effect.gen(function* () {
        const launching = yield* Effect.forkChild(
          Effect.gen(function* () {
            return yield* (yield* ChildBackend).launch(request());
          }),
        );
        const session = yield* joinAdvancingClock(launching);

        assert.strictEqual((yield* session.result).message, LOGIN_ERROR);
        assert.lengthOf(launches, 4, "one launch and three retries");
        assert.deepStrictEqual(
          logs.lines
            .filter((line) => line.includes("launching it again"))
            .map((line) => /"delay":"([^"]+)"/u.exec(line)?.[1]),
          ["15s", "30s", "1m"],
        );
      }).pipe(
        Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
        Effect.scoped,
      );
    }),
  );

  it.effect("opens no other Claude process once a launch waiting to retry is interrupted", () =>
    Effect.gen(function* () {
      const { launches, sdk } = loginRace(Number.POSITIVE_INFINITY);
      yield* Effect.gen(function* () {
        const launching = yield* Effect.forkChild(
          Effect.gen(function* () {
            return yield* (yield* ChildBackend).launch(request());
          }),
        );
        while (launches[0]?.closed !== true) yield* Effect.yieldNow;
        yield* Fiber.interrupt(launching);
        yield* TestClock.adjust("2 minutes");
        assert.lengthOf(launches, 1, "the canceled child starts no retry");
      }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk))), Effect.scoped);
    }),
  );

  it.effect(
    "holds the Worker's Claude login lock until Claude shows its login worked, for a minute at most",
    () =>
      Effect.gen(function* () {
        const outputs: Array<Queue.Queue<Schema.Json, Cause.Done>> = [];
        const context = yield* Effect.context<never>();
        const sdk = Layer.succeed(ClaudeSdk)({
          open: () => {
            const messages = Effect.runSyncWith(context)(Queue.make<Schema.Json, Cause.Done>());
            outputs.push(messages);
            const output = Stream.toAsyncIterableWith(Stream.fromQueue(messages), context);
            return {
              close: () => {
                Effect.runForkWith(context)(Queue.end(messages));
              },
              interrupt: () => Promise.resolve(),
              usesApiKey: () => Promise.resolve(false),
              supportedModels: () => Promise.resolve([{ value: "claude-sonnet-4-6" }]),
              [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
            };
          },
        });
        yield* Effect.gen(function* () {
          const backend = yield* ChildBackend;
          const logins = yield* HostLoginLock;
          const worker = request().worker;
          const preflight = () =>
            logins.withLock(Harness.make("claude"), worker, Option.none())(Effect.void);

          const answering = yield* Effect.forkChild(backend.launch(request()));
          while (outputs.length < 1) yield* Effect.yieldNow;
          const waitingForAnswer = yield* Effect.forkChild(preflight());
          yield* Effect.yieldNow;
          assert.isUndefined(
            waitingForAnswer.pollUnsafe(),
            "a preflight waits while the child has shown nothing",
          );
          yield* Queue.offer(outputs[0]!, rateLimitEvent);
          yield* Fiber.join(waitingForAnswer);
          yield* Fiber.join(answering);

          const silent = yield* Effect.forkChild(backend.launch(request()));
          while (outputs.length < 2) yield* Effect.yieldNow;
          const waitingForSilence = yield* Effect.forkChild(preflight());
          yield* Effect.yieldNow;
          assert.isUndefined(waitingForSilence.pollUnsafe());
          yield* TestClock.adjust("1 minute");
          yield* Fiber.join(waitingForSilence);
          yield* Fiber.join(silent);
        }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk))), Effect.scoped);
      }),
  );

  it.effect(
    "rejects malformed background snapshots instead of treating them as no pending work",
    () => {
      const sdk = Layer.succeed(ClaudeSdk)({
        open: () =>
          scripted([
            { type: "system", subtype: "background_tasks_changed", tasks: "invalid" },
            { type: "result", subtype: "success", result: "Waiting for gate" },
          ]),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const session = yield* (yield* ChildBackend).launch(request());
          const error = yield* Effect.flip(session.result);
          const matchesError = Schema.is(SessionOperationError)(error);
          assert(matchesError);
          assert.strictEqual(error.operation, "stream");
          assert.match(error.message, /invalid completion update/u);
        }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
      );
    },
  );

  it.effect("waits for queued user turns while ambient watchers do not prevent completion", () => {
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () =>
        scripted([
          { type: "system", subtype: "session_state_changed", state: "running" },
          {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "watcher", ambient: true }],
          },
          { type: "result", subtype: "success", result: "First answer", queued_turn_count: 1 },
          { type: "system", subtype: "session_state_changed", state: "idle" },
          { type: "system", subtype: "session_state_changed", state: "running" },
          { type: "result", subtype: "success", result: "Updated answer", queued_turn_count: 0 },
          { type: "system", subtype: "session_state_changed", state: "idle" },
        ]),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* ChildBackend).launch(request());

        assert.strictEqual((yield* session.result).message, "Updated answer");
      }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
    );
  });

  it.effect(
    "waits through background work and its notification turn without an operator Hold",
    () => {
      const sdk = Layer.succeed(ClaudeSdk)({
        open: () =>
          scripted([
            { type: "system", subtype: "session_state_changed", state: "running" },
            {
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [{ task_id: "gate", task_type: "local_bash", description: "Run gate" }],
            },
            {
              type: "result",
              subtype: "success",
              result: "Waiting for gate",
              queued_turn_count: 0,
            },
            { type: "system", subtype: "session_state_changed", state: "idle" },
            // An empty task snapshot is not a final answer; the notification still needs a turn.
            { type: "system", subtype: "background_tasks_changed", tasks: [] },
            { type: "system", subtype: "task_notification", task_id: "gate", status: "completed" },
            { type: "system", subtype: "session_state_changed", state: "running" },
            { type: "system", subtype: "init", session_id: "claude-session-1" },
            {
              type: "assistant",
              message: { content: [{ type: "text", text: "Gate passed; PR published" }] },
            },
            {
              type: "result",
              subtype: "success",
              result: "Gate passed; PR published",
              queued_turn_count: 0,
            },
            { type: "system", subtype: "session_state_changed", state: "idle" },
          ]),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const session = yield* (yield* ChildBackend).launch(request());
          const [events, result] = yield* Effect.all([
            Stream.runCollect(session.events),
            session.result,
          ]);
          assert.strictEqual(result.message, "Gate passed; PR published");
          assert.deepStrictEqual(
            events.map((event) => event._tag),
            ["SessionStarted", "TextOutput", "SessionFinished"],
          );
        }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
      );
    },
  );

  it.effect(
    "does not return a saved waiting answer when background work ends without another result",
    () => {
      const sdk = Layer.succeed(ClaudeSdk)({
        open: () =>
          scripted([
            { type: "system", subtype: "session_state_changed", state: "running" },
            {
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [{ task_id: "gate", task_type: "local_bash", description: "Run gate" }],
            },
            {
              type: "result",
              subtype: "success",
              result: "Waiting for gate",
              queued_turn_count: 0,
            },
            { type: "system", subtype: "session_state_changed", state: "idle" },
            { type: "system", subtype: "background_tasks_changed", tasks: [] },
            { type: "system", subtype: "session_state_changed", state: "idle" },
          ]),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const session = yield* (yield* ChildBackend).launch(request());
          const error = yield* Effect.flip(session.result);
          const matchesError = Schema.is(SessionOperationError)(error);
          assert(matchesError);
          assert.strictEqual(error.operation, "stream");
        }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
      );
    },
  );

  describe("after an answer while background work runs", () => {
    const gate = {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "ci-watch", task_type: "local_bash", description: "Watch CI" }],
    };
    const answered = (result: string) => ({
      type: "result",
      subtype: "success",
      result,
      queued_turn_count: 0,
    });
    const waiting = (lines: ReadonlyArray<string>) =>
      lines.some((line) => line.includes("Claude child is waiting for background work"));

    const cancelled = (lines: ReadonlyArray<string>, reason: string) =>
      lines.some(
        (line) =>
          line.includes("Claude child cancelled the wait limit for its background work") &&
          line.includes(`"reason":"${reason}"`),
      );

    it.effect.each([
      {
        protocol: "session-state",
        messages: [
          { type: "system", subtype: "session_state_changed", state: "running" },
          gate,
          answered("Review posted"),
          { type: "system", subtype: "session_state_changed", state: "idle" },
        ],
      },
      { protocol: "legacy", messages: [gate, answered("Review posted")] },
    ])("returns the answer once the wait limit passes ($protocol)", ({ messages }) =>
      Effect.gen(function* () {
        const { query, sdk } = yield* openOutput(messages);
        const logs = logLines(["Info", "Warn"]);
        yield* Effect.gen(function* () {
          const session = yield* (yield* ChildBackend).launch(request());
          const result = yield* Effect.forkChild(session.result);
          while (!waiting(logs.lines)) yield* Effect.yieldNow;
          assert.isTrue(
            logs.lines.some((line) => waiting([line]) && line.includes('"limit":"2m"')),
            "the waiting log names the limit",
          );
          yield* TestClock.adjust("119 seconds");
          assert.isUndefined(result.pollUnsafe(), "the child waits until the limit");
          yield* TestClock.adjust("1 second");
          assert.strictEqual((yield* Fiber.join(result)).message, "Review posted");
          const outlasted = logs.lines.findIndex((line) =>
            line.includes("outlasted the wait limit"),
          );
          assert.strictEqual(logs.lineLevels[outlasted], "Warn", "the limit logs a warning");
          assert.include(logs.lines[outlasted], '"backgroundTaskIds":["ci-watch"]');
          assert.include(logs.lines[outlasted], '"limit":"2m"');
          assert.isFalse(query.closed, "the answer alone does not close the Claude process");
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
          Effect.scoped,
        );
        assert.isTrue(query.closed, "closing the child closes the Claude process");
      }),
    );

    it.effect.each([
      {
        protocol: "session-state",
        messages: [
          { type: "system", subtype: "session_state_changed", state: "running" },
          gate,
          answered("Waiting for CI"),
          { type: "system", subtype: "session_state_changed", state: "idle" },
        ],
        notification: [
          { type: "system", subtype: "background_tasks_changed", tasks: [] },
          { type: "system", subtype: "session_state_changed", state: "running" },
        ],
        rest: [
          answered("CI passed"),
          { type: "system", subtype: "session_state_changed", state: "idle" },
        ],
        answer: "CI passed",
      },
      {
        protocol: "legacy",
        messages: [gate, answered("Waiting for CI")],
        notification: [
          { type: "system", subtype: "background_tasks_changed", tasks: [] },
          { type: "assistant", message: { content: [{ type: "text", text: "CI finished" }] } },
        ],
        rest: [answered("CI passed")],
        answer: "CI passed",
      },
      {
        protocol: "legacy, result only",
        messages: [gate, answered("Waiting for CI")],
        notification: [
          { type: "system", subtype: "background_tasks_changed", tasks: [] },
          { type: "result", subtype: "success", result: "Folded", queued_turn_count: 1 },
        ],
        rest: [answered("Queued turn done")],
        answer: "Queued turn done",
      },
    ])(
      "does not end a notification turn that starts within the limit ($protocol)",
      ({ messages, notification, rest, answer }) =>
        Effect.gen(function* () {
          const { output, sdk } = yield* openOutput(messages);
          const logs = infoLines();
          yield* Effect.gen(function* () {
            const session = yield* (yield* ChildBackend).launch(request());
            const result = yield* Effect.forkChild(session.result);
            while (!waiting(logs.lines)) yield* Effect.yieldNow;
            yield* TestClock.adjust("1 minute");
            yield* Queue.offerAll(output, notification);
            while (!cancelled(logs.lines, "turn started")) yield* Effect.yieldNow;
            yield* TestClock.adjust("5 minutes");
            assert.isUndefined(result.pollUnsafe(), "the running turn keeps the child open");
            yield* Queue.offerAll(output, rest);
            assert.strictEqual((yield* Fiber.join(result)).message, answer);
          }).pipe(
            Effect.provide(
              claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer)),
            ),
            Effect.scoped,
          );
        }),
    );

    it.effect("keeps a held child open past the limit until its notification turn answers", () =>
      Effect.gen(function* () {
        const { output, sdk } = yield* openOutput([
          { type: "system", subtype: "session_state_changed", state: "running" },
          gate,
          answered("Waiting for CI"),
          { type: "system", subtype: "session_state_changed", state: "idle" },
        ]);
        const logs = logLines(["Info", "Warn"]);
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            ChildRequest.make({ ...request(), held: true }),
          );
          const events: Array<string> = [];
          yield* Effect.forkScoped(
            running.events.pipe(
              Stream.runForEach((event) => Effect.sync(() => events.push(event._tag))),
            ),
          );
          const result = yield* Effect.forkChild(running.result);
          while (!waiting(logs.lines)) yield* Effect.yieldNow;
          yield* TestClock.adjust("2 minutes");
          while (!logs.lines.some((line) => line.includes("outlasted the wait limit")))
            yield* Effect.yieldNow;
          const outlasted = logs.lines.findIndex((line) =>
            line.includes("outlasted the wait limit"),
          );
          assert.include(logs.lines[outlasted], "the operator's Hold or pause keeps it open");
          assert.strictEqual(logs.lineLevels[outlasted], "Info");
          assert.notInclude(events, "SessionIdle", "the limit does not report a held child idle");
          yield* Queue.offerAll(output, [
            { type: "system", subtype: "background_tasks_changed", tasks: [] },
            { type: "system", subtype: "session_state_changed", state: "running" },
            { type: "assistant", message: { content: [{ type: "text", text: "CI finished" }] } },
          ]);
          while (!cancelled(logs.lines, "turn started")) yield* Effect.yieldNow;
          yield* running.intervene(Release.make(), noDelivery);
          yield* TestClock.adjust("5 minutes");
          assert.isUndefined(result.pollUnsafe(), "a Release does not end the running turn");
          yield* Queue.offerAll(output, [
            answered("CI passed"),
            { type: "system", subtype: "session_state_changed", state: "idle" },
          ]);
          assert.strictEqual((yield* Fiber.join(result)).message, "CI passed");
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
          Effect.scoped,
        );
      }),
    );

    const supervisedLimit = (lines: ReadonlyArray<string>) =>
      lines.some((line) => line.includes("the operator's Hold or pause keeps it open"));

    it.effect.each([
      {
        protocol: "session-state",
        messages: [
          { type: "system", subtype: "session_state_changed", state: "running" },
          gate,
          answered("Waiting for CI"),
          { type: "system", subtype: "session_state_changed", state: "idle" },
        ],
      },
      { protocol: "legacy", messages: [gate, answered("Waiting for CI")] },
    ])("returns the answer on a Release after the limit passes ($protocol)", ({ messages }) =>
      Effect.gen(function* () {
        const { sdk } = yield* openOutput(messages);
        const logs = infoLines();
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            ChildRequest.make({ ...request(), held: true }),
          );
          const result = yield* Effect.forkChild(running.result);
          while (!waiting(logs.lines)) yield* Effect.yieldNow;
          yield* TestClock.adjust("2 minutes");
          while (!supervisedLimit(logs.lines)) yield* Effect.yieldNow;
          yield* TestClock.adjust("5 minutes");
          assert.isUndefined(result.pollUnsafe(), "the Hold keeps the child open");
          yield* running.intervene(Release.make(), noDelivery);
          assert.strictEqual((yield* Fiber.join(result)).message, "Waiting for CI");
          assert.isTrue(
            logs.lines.some((line) =>
              line.includes(
                "The operator released a session whose wait limit passed; returning its answer",
              ),
            ),
          );
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
          Effect.scoped,
        );
      }),
    );

    it.effect("keeps a child interrupted during the wait open past the limit", () =>
      Effect.gen(function* () {
        const { sdk } = yield* openOutput([
          { type: "system", subtype: "session_state_changed", state: "running" },
          gate,
          answered("Waiting for CI"),
          { type: "system", subtype: "session_state_changed", state: "idle" },
        ]);
        const logs = logLines(["Info", "Warn"]);
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(request());
          const events: Array<string> = [];
          yield* Effect.forkScoped(
            running.events.pipe(
              Stream.runForEach((event) => Effect.sync(() => events.push(event._tag))),
            ),
          );
          const result = yield* Effect.forkChild(running.result);
          while (!waiting(logs.lines)) yield* Effect.yieldNow;
          yield* TestClock.adjust("1 minute");
          yield* running.intervene(Interrupt.make(), noDelivery);
          yield* TestClock.adjust("1 minute");
          while (!supervisedLimit(logs.lines)) yield* Effect.yieldNow;
          assert.isFalse(
            logs.lines.some((line) => line.includes("returning its answer")),
            "the pause keeps the answer",
          );
          assert.notInclude(events, "SessionIdle", "the limit does not report a paused child idle");
          yield* running.intervene(Release.make(), noDelivery);
          yield* TestClock.adjust("5 minutes");
          assert.isUndefined(result.pollUnsafe(), "a Release does not end a paused child");
          assert.notInclude(events, "SessionIdle", "a Release does not report a paused child idle");
          assert.isFalse(
            logs.lines.some((line) => line.includes("returning its answer")),
            "a Release keeps a paused child's answer",
          );
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
          Effect.scoped,
        );
      }),
    );

    it.effect("drops the kept answer when an operator message starts a turn", () =>
      Effect.gen(function* () {
        const { output, sdk } = yield* openOutput([
          { type: "system", subtype: "session_state_changed", state: "running" },
          gate,
          answered("Waiting for CI"),
          { type: "system", subtype: "session_state_changed", state: "idle" },
        ]);
        const logs = infoLines();
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            ChildRequest.make({ ...request(), held: true }),
          );
          const events: Array<string> = [];
          yield* Effect.forkScoped(
            running.events.pipe(
              Stream.runForEach((event) => Effect.sync(() => events.push(event._tag))),
            ),
          );
          const result = yield* Effect.forkChild(running.result);
          while (!waiting(logs.lines)) yield* Effect.yieldNow;
          yield* TestClock.adjust("2 minutes");
          while (!supervisedLimit(logs.lines)) yield* Effect.yieldNow;
          yield* running.intervene(OperatorMessage.make({ message: "Is CI done?" }), noDelivery);
          assert.isTrue(
            logs.lines.some((line) =>
              line.includes("The operator's input starts a turn; dropping the overdue answer"),
            ),
          );
          // The Release lands before Claude's first frame of the message's turn.
          yield* running.intervene(Release.make(), noDelivery);
          yield* TestClock.adjust("5 minutes");
          assert.isUndefined(result.pollUnsafe(), "a Release does not return the dropped answer");
          assert.notInclude(events, "SessionFinished");
          yield* Queue.offerAll(output, [
            { type: "system", subtype: "background_tasks_changed", tasks: [] },
            { type: "system", subtype: "session_state_changed", state: "running" },
            answered("CI is still running"),
            { type: "system", subtype: "session_state_changed", state: "idle" },
          ]);
          assert.strictEqual((yield* Fiber.join(result)).message, "CI is still running");
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
          Effect.scoped,
        );
      }),
    );

    it.effect("keeps a child held by an operator message during its turn until a Release", () =>
      Effect.gen(function* () {
        const { output, sdk } = yield* openOutput([
          { type: "system", subtype: "session_state_changed", state: "running" },
          gate,
        ]);
        const logs = logLines(["Info", "Warn"]);
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(request());
          const events: Array<string> = [];
          yield* Effect.forkScoped(
            running.events.pipe(
              Stream.runForEach((event) => Effect.sync(() => events.push(event._tag))),
            ),
          );
          const result = yield* Effect.forkChild(running.result);
          const state = yield* running.intervene(
            OperatorMessage.make({ message: "Wait for CI" }),
            noDelivery,
          );
          assert.isTrue(state.held, "the operator message places a Hold");
          yield* Queue.offerAll(output, [
            answered("Waiting for CI"),
            { type: "system", subtype: "session_state_changed", state: "idle" },
          ]);
          while (!waiting(logs.lines)) yield* Effect.yieldNow;
          yield* TestClock.adjust("2 minutes");
          while (!supervisedLimit(logs.lines)) yield* Effect.yieldNow;
          assert.notInclude(events, "SessionIdle", "the limit does not report a held child idle");
          assert.isUndefined(result.pollUnsafe(), "the Hold keeps the child open");
          yield* running.intervene(Release.make(), noDelivery);
          assert.strictEqual((yield* Fiber.join(result)).message, "Waiting for CI");
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
          Effect.scoped,
        );
      }),
    );

    it.effect("returns the answer at the limit after a Release within it", () =>
      Effect.gen(function* () {
        const { sdk } = yield* openOutput([
          { type: "system", subtype: "session_state_changed", state: "running" },
          gate,
          answered("Waiting for CI"),
          { type: "system", subtype: "session_state_changed", state: "idle" },
        ]);
        const logs = logLines(["Info", "Warn"]);
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            ChildRequest.make({ ...request(), held: true }),
          );
          const result = yield* Effect.forkChild(running.result);
          while (!waiting(logs.lines)) yield* Effect.yieldNow;
          yield* TestClock.adjust("1 minute");
          yield* running.intervene(Release.make(), noDelivery);
          assert.isUndefined(result.pollUnsafe(), "the Release waits for the limit");
          yield* TestClock.adjust("1 minute");
          assert.strictEqual((yield* Fiber.join(result)).message, "Waiting for CI");
          const outlasted = logs.lines.findIndex((line) =>
            line.includes("outlasted the wait limit"),
          );
          assert.include(logs.lines[outlasted], "returning its answer");
          assert.strictEqual(logs.lineLevels[outlasted], "Warn");
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
          Effect.scoped,
        );
      }),
    );

    const lost = { type: "test_process_lost" };
    /** A Claude SDK whose launches each read a new queue, and throw `ChildProcessLost` on `lost`. */
    const resumableSdk = Effect.gen(function* () {
      const outputs: Array<Queue.Queue<Schema.Json, Cause.Done>> = [];
      const context = yield* Effect.context<never>();
      const sdk = Layer.succeed(ClaudeSdk)({
        open: (input) => {
          const output = Effect.runSyncWith(context)(Queue.make<Schema.Json, Cause.Done>());
          outputs.push(output);
          void (async () => {
            for await (const _message of input) Queue.offerUnsafe(output, rateLimitEvent);
          })();
          return {
            ...scripted([]),
            close: () => Queue.endUnsafe(output),
            async *[Symbol.asyncIterator]() {
              for (;;) {
                const next = await Effect.runPromiseWith(context)(
                  Effect.option(Queue.take(output)),
                );
                if (Option.isNone(next)) return;
                if (next.value === lost)
                  throw ChildProcessLost.make({ exitCode: 255, stderrTail: "" });
                yield next.value;
              }
            },
          };
        },
      });
      return { outputs, sdk };
    });

    it.effect("returns the continuation's answer after a process resume within the limit", () =>
      Effect.gen(function* () {
        const { outputs, sdk } = yield* resumableSdk;
        const logs = infoLines();
        yield* Effect.gen(function* () {
          const session = yield* (yield* ChildBackend).launch(
            request(undefined, undefined, exitingHost(0)),
          );
          const result = yield* Effect.forkChild(session.result);
          yield* Queue.offerAll(outputs[0]!, [gate, answered("Waiting for CI")]);
          while (!waiting(logs.lines)) yield* Effect.yieldNow;
          yield* Queue.offer(outputs[0]!, lost);
          while (!logs.lines.some((line) => line.includes("Resumed the Claude child's session")))
            yield* Effect.yieldNow;
          assert.isTrue(cancelled(logs.lines, "process resumed"));
          yield* TestClock.adjust("5 minutes");
          assert.isUndefined(result.pollUnsafe(), "the continuation turn keeps the child open");
          yield* Queue.offer(outputs.at(-1)!, answered("Continued"));
          assert.strictEqual((yield* Fiber.join(result)).message, "Continued");
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
          Effect.scoped,
        );
      }),
    );

    it.effect("returns the kept answer on a Release after a process resume", () =>
      Effect.gen(function* () {
        const { outputs, sdk } = yield* resumableSdk;
        const logs = infoLines();
        yield* Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            ChildRequest.make({ ...request(undefined, undefined, exitingHost(0)), held: true }),
          );
          const events: Array<string> = [];
          yield* Effect.forkScoped(
            running.events.pipe(
              Stream.runForEach((event) => Effect.sync(() => events.push(event._tag))),
            ),
          );
          const result = yield* Effect.forkChild(running.result);
          yield* Queue.offerAll(outputs[0]!, [gate, answered("Waiting for CI")]);
          while (!waiting(logs.lines)) yield* Effect.yieldNow;
          yield* TestClock.adjust("2 minutes");
          while (!supervisedLimit(logs.lines)) yield* Effect.yieldNow;
          yield* Queue.offer(outputs[0]!, lost);
          while (!logs.lines.some((line) => line.includes("Resumed the Claude child's session")))
            yield* Effect.yieldNow;
          assert.isTrue(
            logs.lines.some((line) =>
              line.includes("The recovered session reports the answer whose wait limit passed"),
            ),
          );
          // The recovery reports the kept answer.
          while (!events.includes("SessionIdle")) yield* Effect.yieldNow;
          yield* TestClock.adjust("5 minutes");
          assert.isUndefined(result.pollUnsafe(), "the Hold keeps the child open");
          yield* running.intervene(Release.make(), noDelivery);
          assert.strictEqual((yield* Fiber.join(result)).message, "Waiting for CI");
        }).pipe(
          Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(logs.layer))),
          Effect.scoped,
        );
      }),
    );
  });

  it.effect("closes a paused tool hook with its child scope even without a vendor abort", () =>
    Effect.gen(function* () {
      const messages = yield* Queue.make<Schema.Json, Cause.Done>();
      // A launch returns after the first rate-limit event confirms the login.
      yield* Queue.offer(messages, rateLimitEvent);
      const context = yield* Effect.context<never>();
      const output = Stream.toAsyncIterableWith(Stream.fromQueue(messages), context);
      let options: ClaudeQueryOptions | undefined;
      const sdk = Layer.succeed(ClaudeSdk)({
        open: (_input, supplied) => {
          options = supplied;
          return {
            close: () => {
              Effect.runForkWith(context)(Queue.end(messages));
            },
            interrupt: () => Promise.resolve(),
            usesApiKey: () => Promise.resolve(false),
            supportedModels: () => Promise.resolve([{ value: "claude-sonnet-4-6" }]),
            [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          };
        },
      });
      const owner = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
      const running = yield* Effect.gen(function* () {
        return yield* (yield* ChildBackend).launch(request());
      }).pipe(Scope.provide(owner), Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk))));
      yield* running.intervene(Interrupt.make(), noDelivery);
      const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
      assert(hook !== undefined);

      const settled = hook(
        {
          hook_event_name: "PreToolUse",
          session_id: "child-1",
          transcript_path: "/tmp/claude-transcript",
          cwd: "/workspace/repo",
          tool_name: "Read",
          tool_input: { file_path: "README.md" },
          tool_use_id: "read-1",
        },
        "read-1",
        { signal: yield* Effect.abortSignal },
      ).then(
        () => "resumed",
        () => "interrupted",
      );
      yield* Effect.yieldNow;
      yield* Scope.close(owner, Exit.void);
      const responseBody = yield* Effect.promise(() => settled);
      assert.strictEqual(responseBody, "interrupted");
    }).pipe(Effect.scoped),
  );

  it.effect("reports each API retry of a turn and the recovery when an answer arrives", () => {
    const retry = (attempt: number, status: number | null, error: string) => ({
      type: "system",
      subtype: "api_retry",
      attempt,
      max_retries: 10,
      retry_delay_ms: 4_000,
      error_status: status,
      error,
      uuid: `retry-${attempt}`,
      session_id: "claude-session-1",
    });
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () =>
        scripted([
          retry(1, null, "unknown"),
          retry(2, 529, "overloaded"),
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "Child completed the edit." }] },
          },
          { type: "result", subtype: "success", result: "Child completed the edit." },
        ]),
    });
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(jsonKey(message));
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* ChildBackend).launch(request());
        const [events] = yield* Effect.all([Stream.runCollect(session.events), session.result]);
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          [
            "SessionStarted",
            "ProviderRetrying",
            "ProviderRetrying",
            "ProviderRecovered",
            "TextOutput",
            "SessionFinished",
          ],
        );
        assert.deepStrictEqual(
          events.flatMap((event) =>
            event._tag === "ProviderRetrying" ? [[event.message, event.retries]] : [],
          ),
          [
            ["API request failed without a response (unknown); retry 1 of 10 in 4s", 1],
            ["API request failed with HTTP 529 (overloaded); retry 2 of 10 in 4s", 2],
          ],
        );
        const recovered = events.find((event) => event._tag === "ProviderRecovered");
        assert(recovered?._tag === "ProviderRecovered");
        assert.strictEqual(recovered.retries, 2);
        const retries = warnings.filter((line) => line.includes("cannot reach its provider"));
        assert.lengthOf(retries, 2, "one warning per API retry");
      }).pipe(
        Effect.provide(
          claudeChild.pipe(Layer.provideMerge(sdk), Layer.provideMerge(Logger.layer([logger]))),
        ),
      ),
    );
  });

  it.effect("rejects an unknown model through the typed channel before sending the prompt", () => {
    let closed = false;
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () => ({
        ...scripted([], [{ value: "haiku", resolvedModel: "claude-haiku-4-5" }]),
        close: () => {
          closed = true;
        },
      }),
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* ChildBackend;
          const error = yield* Effect.flip(backend.launch(request("claude-never-existed")));
          const matchesError = Schema.is(UnknownModelError)(error);
          assert(matchesError);
          assert.strictEqual(error.model, "claude-never-existed");
        }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
      );
      assert.strictEqual(closed, true);
    });
  });

  it.effect("maps the usine effort scale onto Claude's options", () => {
    const captured: Array<ClaudeQueryOptions> = [];
    const sdk = Layer.succeed(ClaudeSdk)({
      open: (_input, options) => {
        captured.push(options);
        return scripted([{ type: "result", subtype: "success", result: "done" }]);
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        yield* backend.launch(request(undefined, { effort: "off" }));
        yield* backend.launch(request(undefined, { effort: "minimal" }));
        assert.deepStrictEqual(captured[0]?.thinking, { type: "disabled" });
        assert.strictEqual(captured[0] !== undefined && "effort" in captured[0], false);
        assert.deepStrictEqual(captured[1]?.thinking, { type: "adaptive" });
        assert.strictEqual(captured[1]?.effort, "low");
      }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
    );
  });

  it.effect.each([
    { messages: [], detail: "ran out of turns", capacity: false },
    { messages: [], detail: '529 {"error":{"type":"overloaded_error"}}', capacity: true },
    {
      messages: [
        {
          type: "assistant",
          error: "overloaded",
          message: { content: [{ type: "text", text: "Busy provider" }] },
        },
      ],
      detail: "API failed",
      capacity: true,
    },
    {
      messages: [
        {
          type: "system",
          subtype: "api_retry",
          attempt: 3,
          max_retries: 3,
          retry_delay_ms: 1000,
          error_status: 529,
          error: "server_error",
        },
      ],
      detail: "API failed",
      capacity: true,
    },
    {
      messages: [
        {
          type: "system",
          subtype: "api_retry",
          attempt: 3,
          max_retries: 3,
          retry_delay_ms: 1000,
          error_status: 503,
          error: "server_error",
        },
      ],
      detail: "API failed",
      capacity: true,
    },
    {
      messages: [
        {
          type: "assistant",
          error: "authentication_failed",
          message: { content: [{ type: "text", text: "Selected model is at capacity" }] },
        },
      ],
      detail: "Selected model is at capacity",
      capacity: false,
    },
    {
      messages: [
        {
          type: "system",
          subtype: "api_retry",
          attempt: 3,
          max_retries: 3,
          retry_delay_ms: 1000,
          error_status: 529,
          error: "server_error",
        },
        { type: "assistant", message: { content: [{ type: "text", text: "Recovered" }] } },
      ],
      detail: "ran out of turns",
      capacity: false,
    },
  ])(
    "classifies Claude's terminal refusal: $detail / capacity=$capacity",
    ({ messages, detail, capacity }) => {
      const sdk = Layer.succeed(ClaudeSdk)({
        open: () =>
          scripted([
            { type: "system", subtype: "session_state_changed", state: "running" },
            {
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [{ task_id: "gate", task_type: "local_bash", description: "Run gate" }],
            },
            ...messages,
            { type: "result", subtype: "error_during_execution", errors: [detail] },
          ]),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* ChildBackend;
          const session = yield* backend.launch(request());
          const error = yield* Effect.flip(session.result);
          assert.strictEqual(Schema.is(AgentCapacityError)(error), capacity);
          const matchesError = Schema.is(AgentResultError)(error);
          if (!capacity) assert(matchesError);
        }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
      );
    },
  );

  // Claude Code ends a turn on an API error with a `success` result that has `is_error` (#1147).
  const LIMIT_TEXT = "You've hit your limit · resets 5am (UTC)";
  const rejected = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: 1_794_373_200,
    },
  };
  const limitError = {
    type: "assistant",
    error: "rate_limit",
    message: { content: [{ type: "text", text: LIMIT_TEXT }] },
  };
  const overloadError = {
    type: "assistant",
    error: "overloaded",
    message: { content: [{ type: "text", text: LIMIT_TEXT }] },
  };
  const rateLimitRetry = {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 5_000,
    error_status: 429,
    error: "rate_limit",
  };
  const OVERLOAD_TEXT = "Repeated server overload; giving up";
  const UNAVAILABLE_TEXT = "API Error: 503 Service Unavailable. Please try again later.";
  const limitResult = {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 429,
    result: LIMIT_TEXT,
  };
  it.effect.each([
    {
      name: "a rejected usage limit",
      messages: [rejected, limitError, limitResult],
      resetsAt: Option.some("2026-11-11T05:00:00.000Z"),
    },
    {
      name: "an HTTP 429 result",
      messages: [rejected, limitResult],
      resetsAt: Option.some("2026-11-11T05:00:00.000Z"),
    },
    {
      name: "a rate limit without a reported reset time",
      messages: [limitError, limitResult],
      resetsAt: Option.none(),
    },
    {
      name: "a rate limit on a result without an HTTP status",
      messages: [rejected, limitError, { ...limitResult, api_error_status: null }],
      resetsAt: Option.some("2026-11-11T05:00:00.000Z"),
    },
    {
      name: "a rate-limited API retry with HTTP 429 that ends the turn",
      messages: [
        rejected,
        { ...rateLimitRetry, error: "unknown" },
        { type: "result", subtype: "error_during_execution", errors: ["API failed"] },
      ],
      resetsAt: Option.some("2026-11-11T05:00:00.000Z"),
      message: "API request failed with HTTP 429 (unknown); retry 1 of 10 in 5s",
    },
    {
      name: "a rate-limited API retry without a response that ends the turn",
      messages: [
        rejected,
        { ...rateLimitRetry, error_status: null },
        { type: "result", subtype: "error_during_execution", errors: ["API failed"] },
      ],
      resetsAt: Option.some("2026-11-11T05:00:00.000Z"),
      message: "API request failed without a response (rate_limit); retry 1 of 10 in 5s",
    },
    {
      name: "an overload that ends the turn",
      messages: [overloadError, { ...limitResult, api_error_status: 529 }],
      resetsAt: Option.none(),
    },
    {
      name: "an overload during a usage-limit warning",
      messages: [
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.9,
            resetsAt: 1_794_373_200,
          },
        },
        overloadError,
        { ...limitResult, api_error_status: 529 },
      ],
      resetsAt: Option.none(),
    },
    {
      name: "an HTTP 529 result without an overload error",
      messages: [{ ...limitResult, api_error_status: 529, result: OVERLOAD_TEXT }],
      resetsAt: Option.none(),
      message: OVERLOAD_TEXT,
    },
    {
      name: "an HTTP 503 result that asks to retry",
      messages: [{ ...limitResult, api_error_status: 503, result: UNAVAILABLE_TEXT }],
      resetsAt: Option.none(),
      message: UNAVAILABLE_TEXT,
    },
  ])("fails the session with a capacity refusal after $name", (testCase) => {
    const { messages, resetsAt } = testCase;
    const sdk = Layer.succeed(ClaudeSdk)({ open: () => scripted(messages) });
    return Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* ChildBackend).launch(request());
        const error = yield* Effect.flip(session.result);
        const matchesError = Schema.is(AgentCapacityError)(error);
        assert(matchesError);
        assert.strictEqual(error.message, "message" in testCase ? testCase.message : LIMIT_TEXT);
        assert.deepStrictEqual(error.resetsAt.pipe(Option.map(DateTime.formatIso)), resetsAt);
      }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
    );
  });

  it.effect("returns the text of an API error that is not a provider refusal", () => {
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () =>
        scripted([
          {
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.2 },
          },
          {
            type: "assistant",
            error: "invalid_request",
            message: { content: [{ type: "text", text: "Prompt is too long" }] },
          },
          { ...limitResult, api_error_status: 400, result: "Prompt is too long" },
        ]),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* ChildBackend).launch(request());
        assert.strictEqual((yield* session.result).message, "Prompt is too long");
      }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
    );
  });

  it.effect.each([
    { name: "without is_error", flags: {} },
    { name: "with is_error false", flags: { is_error: false } },
  ])("returns an answer that describes a provider error $name", ({ flags }) => {
    const answer = "The run failed with HTTP 529 overloaded_error; I posted the review";
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () => scripted([{ type: "result", subtype: "success", ...flags, result: answer }]),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* ChildBackend).launch(request());
        assert.strictEqual((yield* session.result).message, answer);
      }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
    );
  });

  it.effect("fails the session as infrastructure when the output closes without a result", () => {
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () => scripted([]),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const session = yield* backend.launch(request());
        const error = yield* Effect.flip(session.result);
        const matchesError = Schema.is(SessionOperationError)(error);
        assert(matchesError);
        assert.strictEqual(error.operation, "stream");
        assert.match(error.message, /closed without a result/u);
      }).pipe(Effect.provide(claudeChild.pipe(Layer.provideMerge(sdk)))),
    );
  });
});
