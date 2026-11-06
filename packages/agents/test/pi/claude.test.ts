import type { ClaudeUserMessage } from "../../src/harness/claude/sdk.ts";
import { jsonKey } from "@usine/core/json-key";
// SDK streams and hooks require native Promises, including the test implementations.
// @effect-diagnostics newPromise:off
// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, describe, it } from "@effect/vitest";
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
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import { Interrupt, OperatorMessage, Release } from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { type ChildHost, LocalProcess, RemoteShell } from "../../src/child-host/child-host.ts";
import {
  AgentResultError,
  AgentCapacityError,
  ChildBackend,
  ChildRequest,
  ChildSessionJournal,
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
  claudeChildLayer.pipe(Layer.provideMerge(loginLock), Layer.provide(commands));

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
const infoLines = () => {
  const lines: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Info") lines.push(jsonKey(message));
  });
  return { lines, layer: Logger.layer([logger]) };
};

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
  for (const home of ["configured", "default"] as const) {
    it.effect(`refuses a saved remote child with a changed ${home} home`, () => {
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
                    : { ...original.environment, HOME: "/new-home" },
                resume: Option.some(
                  HarnessSession.make({
                    id: HarnessSessionId.make("saved-claude"),
                    cwd: original.cwd,
                    home: Option.some(home === "configured" ? "/old-claude" : "/old-home/.claude"),
                  }),
                ),
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "ContinuationMismatchError");
          assert.include(error.message, "home mismatch");
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
            continued: () => Effect.void,
            delivered: () => Effect.void,
          }),
        );
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
