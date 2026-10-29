import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Effort, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
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
import {
  Interrupt,
  type InterventionState,
  OperatorMessage,
  Release,
} from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHILD_STOP_SCRIPT,
  type ChildHost,
  LocalProcess,
  RemoteShell,
  SSH_FAILURE,
  sshArguments,
} from "../../src/child-host/child-host.ts";
import {
  AgentResultError,
  AgentCapacityError,
  ChildBackend,
  ChildRequest,
  ClaudeLoginLock,
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
  type ClaudeUserMessage,
} from "../../src/pi/claude/claude.ts";

/** A single login lock for all Workers, since each test launches its children on one Worker. */
const loginLock = Layer.effect(
  ClaudeLoginLock,
  Effect.map(Semaphore.make(1), (mutex) =>
    ClaudeLoginLock.of({ withLock: () => (effect) => mutex.withPermit(effect) }),
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

const RECORD_SSH = fileURLToPath(new URL("../fixtures/record-ssh.mjs", import.meta.url));

const request = (
  model = "claude-sonnet-4-6",
  options?: { readonly harness?: Harness; readonly effort?: Effort },
  host: ChildHost = new LocalProcess(),
) =>
  new ChildRequest({
    worker: WorkerName.make("worker-1"),
    machine: Option.none(),
    environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
    host,
    session: new ChildSession({
      id: AgentSessionId.make("parent:attempt-1:child:1"),
      parentId: AgentSessionId.make("parent:attempt-1"),
      agent: AgentName.make("developer"),
      brain: new BrainSpec({
        harness: "claude",
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
  const launches: Array<{ closed: boolean }> = [];
  const sdk = Layer.succeed(ClaudeSdk)({
    open: () => {
      const launch = { closed: false };
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
    if (logLevel === "Info") lines.push(JSON.stringify(message));
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
  new RemoteShell({
    ssh: { command: process.execPath, args: ["-e", `process.exit(${code})`] },
    sshEnvironment: {},
    destination: "worker.exe.xyz",
  });

/**
 * Returns a fake Claude SDK whose first launch starts a tool call and then fails, as the live SDK
 * does, once its SSH client exits. Later launches finish the task; `resumed` records the session
 * each one resumes, and `prompts` its first message.
 */
const droppedLaunch = () => {
  const resumed: Array<string | undefined> = [];
  const prompts: Array<string> = [];
  let launches = 0;
  const sdk = Layer.succeed(ClaudeSdk)({
    open: (input, options) => {
      launches += 1;
      if (launches === 1) {
        const spawn = options.spawnClaudeCodeProcess;
        assert(spawn !== undefined);
        const ssh = spawn({
          command: "claude",
          args: [],
          cwd: "/workspace/repo",
          env: {},
          signal: new AbortController().signal,
        });
        const exited = new Promise((resolve) => ssh.once("exit", resolve));
        return {
          ...scripted([]),
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "claude-session-1" };
            yield rateLimitEvent;
            yield {
              type: "assistant",
              message: {
                id: "message-1",
                usage: { input_tokens: 100, output_tokens: 20 },
                content: [{ type: "tool_use", id: "call-1", name: "Bash", input: {} }],
              },
            };
            throw new Error(`Claude Code process exited with code ${String(await exited)}`);
          },
        };
      }
      resumed.push(options.resume);
      return {
        ...scripted([]),
        async *[Symbol.asyncIterator]() {
          const first = await input[Symbol.asyncIterator]().next();
          if (first.done !== true) prompts.push(first.value.message.content);
          yield { type: "system", subtype: "init", session_id: "claude-session-1" };
          yield {
            type: "assistant",
            message: {
              id: "message-2",
              usage: { input_tokens: 50, output_tokens: 10 },
              content: [{ type: "text", text: "Tests pass." }],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            result: "Tests pass.",
            modelUsage: {
              "claude-sonnet-4-6": {
                inputTokens: 50,
                outputTokens: 10,
                cacheCreationInputTokens: 0,
                costUSD: 0.5,
              },
            },
          };
        },
      };
    },
  });
  return { resumed, prompts, sdk };
};

describe("Claude child backend", () => {
  it.effect("launches again after Claude loses its login refresh lock and keeps that session", () =>
    Effect.gen(function* () {
      const { launches, sdk } = loginRace(1);
      const logs = infoLines();
      yield* Effect.gen(function* () {
        const launching = yield* Effect.forkChild((yield* ChildBackend).launch(request()));
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
        assert.strictEqual(started.harnessSession.value.id, "claude-session-2");
        assert.deepStrictEqual(
          launches.map(({ closed }) => closed),
          [true, false],
        );
        const retries = logs.lines.filter((line) => line.includes("launching it again"));
        assert.lengthOf(retries, 1);
        assert.include(retries[0], '"delay":"15s"');
      }).pipe(
        Effect.provide(claudeChild),
        Effect.provide(sdk),
        Effect.provide(logs.layer),
        Effect.scoped,
      );
    }),
  );

  it.effect("returns Claude's login error to the parent once every launch lost the lock", () =>
    Effect.gen(function* () {
      const { launches, sdk } = loginRace(Number.POSITIVE_INFINITY);
      const logs = infoLines();
      yield* Effect.gen(function* () {
        const launching = yield* Effect.forkChild((yield* ChildBackend).launch(request()));
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
        Effect.provide(claudeChild),
        Effect.provide(sdk),
        Effect.provide(logs.layer),
        Effect.scoped,
      );
    }),
  );

  it.effect("opens no other Claude process once a launch waiting to retry is interrupted", () =>
    Effect.gen(function* () {
      const { launches, sdk } = loginRace(Number.POSITIVE_INFINITY);
      yield* Effect.gen(function* () {
        const launching = yield* Effect.forkChild((yield* ChildBackend).launch(request()));
        while (launches[0]?.closed !== true) yield* Effect.yieldNow;
        yield* Fiber.interrupt(launching);
        yield* TestClock.adjust("2 minutes");
        assert.lengthOf(launches, 1, "the canceled child starts no retry");
      }).pipe(Effect.provide(claudeChild), Effect.provide(sdk), Effect.scoped);
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
              supportedModels: () => Promise.resolve([{ value: "claude-sonnet-4-6" }]),
              [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
            };
          },
        });
        yield* Effect.gen(function* () {
          const backend = yield* ChildBackend;
          const logins = yield* ClaudeLoginLock;
          const worker = request().worker;
          const preflight = () => logins.withLock(worker, Option.none())(Effect.void);

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
        }).pipe(Effect.provide(claudeChild), Effect.provide(sdk), Effect.scoped);
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
          assert(error instanceof SessionOperationError);
          assert.strictEqual(error.operation, "stream");
          assert.match(error.message, /invalid completion update/u);
        }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
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
      }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
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
        }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
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
          assert(error instanceof SessionOperationError);
          assert.strictEqual(error.operation, "stream");
        }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
      );
    },
  );

  it.effect("reports a message sent during a turn read once no queued turn holds it", () =>
    Effect.gen(function* () {
      const messages = yield* Queue.make<Schema.Json, Cause.Done>();
      // A launch returns after the first rate-limit event confirms the login.
      yield* Queue.offer(messages, rateLimitEvent);
      const context = yield* Effect.context<never>();
      const output = Stream.toAsyncIterableWith(Stream.fromQueue(messages), context);
      const sdk = Layer.succeed(ClaudeSdk)({
        open: () => ({
          close: () => {
            Effect.runForkWith(context)(Queue.end(messages));
          },
          interrupt: () => Promise.resolve(),
          supportedModels: () => Promise.resolve([{ value: "claude-sonnet-4-6" }]),
          [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        }),
      });
      yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(request());
        const reads: Array<Option.Option<InterventionState>> = [];
        const state = yield* running.intervene(
          new OperatorMessage({ message: "Review with me" }),
          (delivered) =>
            Effect.sync(() => {
              reads.push(delivered);
            }),
        );
        assert.deepStrictEqual([state.held, state.queued], [true, true]);
        yield* Queue.offer(messages, { type: "system", subtype: "init", session_id: "claude-1" });
        yield* Queue.offer(messages, {
          type: "result",
          subtype: "success",
          result: "First answer",
          queued_turn_count: 1,
        });
        yield* Queue.offer(messages, {
          type: "result",
          subtype: "success",
          result: "Reviewed answer",
          queued_turn_count: 0,
        });
        for (let spin = 0; reads.length === 0; spin += 1) {
          if (spin > 1_000) return assert.fail("the read was never reported");
          yield* Effect.yieldNow;
        }
        const [read] = reads;
        assert(read !== undefined && Option.isSome(read));
        assert.deepStrictEqual([read.value.held, read.value.queued], [true, false]);
      }).pipe(Effect.provide(claudeChild), Effect.provide(sdk));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a held Claude conversation open until release and records one launch", () =>
    Effect.gen(function* () {
      const messages = yield* Queue.make<Schema.Json, Cause.Done>();
      // A launch returns after the first rate-limit event confirms the login.
      yield* Queue.offer(messages, rateLimitEvent);
      const idle = yield* Queue.make<void>();
      const context = yield* Effect.context<never>();
      const output = Stream.toAsyncIterableWith(Stream.fromQueue(messages), context);
      let input: AsyncIterator<ClaudeUserMessage> | undefined;
      const sdk = Layer.succeed(ClaudeSdk)({
        open: (stream) => {
          input = stream[Symbol.asyncIterator]();
          return {
            close: () => {
              Effect.runForkWith(context)(Queue.end(messages));
            },
            interrupt: () => Promise.resolve(),
            supportedModels: () => Promise.resolve([{ value: "claude-sonnet-4-6" }]),
            [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          };
        },
      });
      yield* Effect.gen(function* () {
        const running = yield* (yield* ChildBackend).launch(request());
        const result = yield* Effect.forkScoped(running.result);
        const seen: Array<string> = [];
        yield* Effect.forkScoped(
          running.events.pipe(
            Stream.runForEach((event) => {
              seen.push(event._tag);
              return event._tag === "SessionIdle" ? Queue.offer(idle, undefined) : Effect.void;
            }),
          ),
        );
        assert(input !== undefined);
        const entered = input;
        yield* Effect.promise(() => entered.next());
        yield* running.intervene(new OperatorMessage({ message: "Review with me" }), noDelivery);
        assert.strictEqual(
          (yield* Effect.promise(() => entered.next())).value?.message.content,
          "Review with me",
        );
        // The CLI sends `init` with the same session ID before every turn.
        const init = { type: "system", subtype: "init", session_id: "claude-session-1" };
        yield* Queue.offer(messages, init);
        yield* Queue.offer(messages, {
          type: "system",
          subtype: "session_state_changed",
          state: "running",
        });
        yield* Queue.offer(messages, {
          type: "result",
          subtype: "success",
          result: "First answer",
        });
        yield* Queue.offer(messages, {
          type: "system",
          subtype: "session_state_changed",
          state: "idle",
        });
        yield* Queue.take(idle);
        assert.strictEqual(result.pollUnsafe(), undefined);
        yield* running.intervene(
          new OperatorMessage({ message: "One more adjustment" }),
          noDelivery,
        );
        assert.strictEqual(
          (yield* Effect.promise(() => entered.next())).value?.message.content,
          "One more adjustment",
        );
        yield* Queue.offer(messages, init);
        yield* Queue.offer(messages, {
          type: "system",
          subtype: "session_state_changed",
          state: "running",
        });
        yield* Queue.offer(messages, {
          type: "result",
          subtype: "success",
          result: "Adjusted answer",
        });
        yield* Queue.offer(messages, {
          type: "system",
          subtype: "session_state_changed",
          state: "idle",
        });
        yield* Queue.take(idle);
        yield* running.intervene(new Release(), noDelivery);
        assert.strictEqual((yield* Fiber.join(result)).message, "Adjusted answer");
        assert.strictEqual((yield* Effect.promise(() => entered.next())).done, true);
        assert.deepStrictEqual(
          seen.filter((tag) => tag === "SessionStarted"),
          ["SessionStarted"],
        );
      }).pipe(Effect.provide(claudeChild), Effect.provide(sdk));
    }).pipe(Effect.scoped),
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
            supportedModels: () => Promise.resolve([{ value: "claude-sonnet-4-6" }]),
            [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          };
        },
      });
      const owner = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
      const running = yield* Effect.gen(function* () {
        return yield* (yield* ChildBackend).launch(request());
      }).pipe(Scope.provide(owner), Effect.provide(claudeChild), Effect.provide(sdk));
      yield* running.intervene(new Interrupt(), noDelivery);
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
        { signal: new AbortController().signal },
      ).then(
        () => "resumed",
        () => "interrupted",
      );
      yield* Effect.yieldNow;
      yield* Scope.close(owner, Exit.void);
      assert.strictEqual(yield* Effect.promise(() => settled), "interrupted");
    }).pipe(Effect.scoped),
  );

  it.effect("streams normalized session events and runs headlessly with the declared model", () => {
    let input: AsyncIterable<ClaudeUserMessage> | undefined;
    let options: ClaudeQueryOptions | undefined;
    const sdk = Layer.succeed(ClaudeSdk)({
      open: (foundInput, foundOptions) => {
        input = foundInput;
        options = foundOptions;
        return scripted([
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Child completed the edit." },
            },
          },
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "Child completed the edit." }] },
          },
          { type: "result", subtype: "success", result: "Child completed the edit." },
        ]);
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const session = yield* backend.launch(request());
        const [events, result] = yield* Effect.all([
          Stream.runCollect(session.events),
          session.result,
        ]);
        assert.strictEqual(result.message, "Child completed the edit.");
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["SessionStarted", "TextOutput", "SessionFinished"],
        );
        const started = events[0];
        assert(started?._tag === "SessionStarted");
        assert(Option.isSome(started.harnessSession));
        assert.strictEqual(started.harnessSession.value.id, "claude-session-1");
        assert.strictEqual(started.harnessSession.value.cwd, "/workspace/repo");
        assert.strictEqual(options?.model, "claude-sonnet-4-6");
        assert.strictEqual(options?.effort, "high");
        assert.strictEqual(options?.permissionMode, "bypassPermissions");
        assert.strictEqual(options?.pathToClaudeCodeExecutable, "claude");
        assert.strictEqual(options?.allowDangerouslySkipPermissions, true);
        assert.strictEqual(options?.persistSession, true);
        assert.deepStrictEqual(options?.settingSources, ["user"]);
        assert.deepStrictEqual(options?.env, request().environment);
        assert.strictEqual(options?.spawnClaudeCodeProcess, undefined);
        const first = yield* Effect.promise(() => input![Symbol.asyncIterator]().next());
        assert.strictEqual(first.value?.message.content, "Implement the focused task.");
      }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
    );
  });

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
      if (logLevel === "Warn") warnings.push(JSON.stringify(message));
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
        Effect.provide(claudeChild),
        Effect.provide(sdk),
        Effect.provide(Logger.layer([logger])),
      ),
    );
  });

  it.effect("starts Claude Code on a remote host as one SSH command", () => {
    let options: ClaudeQueryOptions | undefined;
    const sdk = Layer.succeed(ClaudeSdk)({
      open: (_input, supplied) => {
        options = supplied;
        return scripted([{ type: "result", subtype: "success", result: "done" }]);
      },
    });
    const record = join(mkdtempSync(join(tmpdir(), "usine-claude-ssh-")), "ssh.json");
    const host = new RemoteShell({
      ssh: { command: process.execPath, args: [RECORD_SSH] },
      sshEnvironment: { RECORD_TO: record },
      destination: "worker.exe.xyz",
    });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* ChildBackend).launch(request(undefined, undefined, host));
        assert.strictEqual(options?.pathToClaudeCodeExecutable, "claude");
        const spawn = options?.spawnClaudeCodeProcess;
        assert(spawn !== undefined);
        const child = spawn({
          command: "claude",
          args: ["--output-format", "stream-json"],
          cwd: "/workspace/repo",
          env: {
            GH_HOST: "github.int.exe.xyz",
            CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
            NODE_OPTIONS: undefined,
          },
          signal: new AbortController().signal,
        });
        const exitCode = yield* Effect.callback<number | null>((resume) => {
          child.once("exit", (code) => resume(Effect.succeed(code)));
        });
        assert.strictEqual(exitCode, 0);
        const spawned = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              argv: Schema.Array(Schema.String),
              env: Schema.Record(Schema.String, Schema.String),
            }),
          ),
        )(readFileSync(record, "utf8"));
        assert.deepStrictEqual(spawned.argv, [
          "worker.exe.xyz",
          "--",
          `cd '/workspace/repo' && export GH_HOST='github.int.exe.xyz' CLAUDE_CODE_ENTRYPOINT='sdk-ts' && sh -c 'printf %s "$$" > "$0" && exec "$@"' '/workspace/repo.child-1.pid' 'claude' '--output-format' 'stream-json'; code=$?; rm -f '/workspace/repo.child-1.pid'; exit "$code"`,
        ]);
        assert.strictEqual(spawned.env.RECORD_TO, record);
        assert.strictEqual(spawned.env.HOME, undefined, "the SSH client inherits nothing");
      }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
    );
  });

  it.effect("resumes a remote child's saved session after its SSH connection breaks", () => {
    const { resumed, prompts, sdk } = droppedLaunch();
    const worker = workerCommands(0, "/workspace/repo.child-1.pid stopped");
    const host = exitingHost(SSH_FAILURE);
    return Effect.gen(function* () {
      const session = yield* (yield* ChildBackend).launch(request(undefined, undefined, host));
      const [events, result] = yield* joinAdvancingClock(
        yield* Effect.forkChild(Effect.all([Stream.runCollect(session.events), session.result])),
      );
      assert.strictEqual(result.message, "Tests pass.", "the same child returns the answer");
      assert.deepStrictEqual(resumed, ["claude-session-1"]);
      assert.match(prompts[0] ?? "", /^usine lost its connection to this session/u);
      assert.deepStrictEqual(worker.commands, [
        [
          host.ssh.command,
          ...sshArguments(host, {
            command: "sh",
            args: ["-c", CHILD_STOP_SCRIPT, "sh", "/workspace/repo.child-1.pid"],
          }),
        ],
      ]);
      assert.deepStrictEqual(
        events.flatMap((event) =>
          event._tag === "ToolFinished" ? [[event.callId, event.isError]] : [],
        ),
        [["call-1", true]],
        "the call that the broken process ran is closed",
      );
      assert.lengthOf(
        events.filter((event) => event._tag === "SessionStarted"),
        1,
      );
      const usage = events.filter((event) => event._tag === "SessionTokensUpdated").at(-1);
      assert(usage?._tag === "SessionTokensUpdated");
      assert.strictEqual(usage.totalTokens, 180, "usage carries over from the broken launch");
      assert.deepStrictEqual(usage.costUsd, Option.some(0.5));
    }).pipe(Effect.provide(claudeChildWith(worker.layer)), Effect.provide(sdk), Effect.scoped);
  });

  it.effect("fails a remote child whose Claude process fails instead of resuming it", () => {
    const { resumed, sdk } = droppedLaunch();
    const worker = workerCommands(0);
    return Effect.gen(function* () {
      const session = yield* (yield* ChildBackend).launch(
        request(undefined, undefined, exitingHost(1)),
      );
      const error = yield* Effect.flip(session.result);
      assert(error instanceof SessionOperationError);
      assert.strictEqual(error.message, "Claude output stream failed");
      assert.deepStrictEqual(resumed, []);
      assert.deepStrictEqual(worker.commands, []);
    }).pipe(Effect.provide(claudeChildWith(worker.layer)), Effect.provide(sdk), Effect.scoped);
  });

  it.effect("fails a remote child once its Worker stays unreachable through every resume", () => {
    const { resumed, sdk } = droppedLaunch();
    const worker = workerCommands(SSH_FAILURE);
    return Effect.gen(function* () {
      const session = yield* (yield* ChildBackend).launch(
        request(undefined, undefined, exitingHost(SSH_FAILURE)),
      );
      const error = yield* joinAdvancingClock(yield* Effect.forkChild(Effect.flip(session.result)));
      assert(error instanceof SessionOperationError);
      assert.strictEqual(error.message, "Claude output stream failed");
      assert.lengthOf(worker.commands, 6, "one stop per resume try");
      assert.deepStrictEqual(resumed, [], "no Claude process starts before the old one stops");
    }).pipe(Effect.provide(claudeChildWith(worker.layer)), Effect.provide(sdk), Effect.scoped);
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
          assert(error instanceof UnknownModelError);
          assert.strictEqual(error.model, "claude-never-existed");
        }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
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
      }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
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
          assert.strictEqual(error instanceof AgentCapacityError, capacity);
          if (!capacity) assert(error instanceof AgentResultError);
        }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
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
        assert(error instanceof SessionOperationError);
        assert.strictEqual(error.operation, "stream");
        assert.match(error.message, /closed without a result/u);
      }).pipe(Effect.provide(claudeChild), Effect.provide(sdk)),
    );
  });
});
