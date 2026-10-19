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
  Stream,
} from "effect";
import {
  Interrupt,
  type InterventionState,
  OperatorMessage,
  Release,
} from "@usine/core/attempt/channel";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChildHost, LocalProcess, RemoteShell } from "../../src/child-host/child-host.ts";
import {
  AgentResultError,
  ChildBackend,
  ChildRequest,
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
} from "../../src/pi/claude.ts";

/** Ignores whether a queued operator message is read; the test does not observe it. */
const noDelivery: OnDelivery = () => Effect.void;

const RECORD_SSH = fileURLToPath(new URL("../fixtures/record-ssh.mjs", import.meta.url));

const request = (
  model = "claude-sonnet-4-6",
  options?: { readonly harness?: Harness; readonly effort?: Effort },
  host: ChildHost = new LocalProcess(),
) =>
  new ChildRequest({
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
): ClaudeQuery => ({
  close: () => undefined,
  interrupt: () => Promise.resolve(),
  supportedModels: () => Promise.resolve(models),
  async *[Symbol.asyncIterator]() {
    yield { type: "system", subtype: "init", session_id: "claude-session-1" };
    for (const message of messages) yield message;
  },
});

describe("Claude child backend", () => {
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
        }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
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
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
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
            // An empty snapshot is not a final answer: the notification still needs a turn.
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
        }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
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
        }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
      );
    },
  );

  it.effect("reports a message sent during a turn read once no queued turn holds it", () =>
    Effect.gen(function* () {
      const messages = yield* Queue.make<Schema.Json, Cause.Done>();
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
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a held Claude conversation open until release and records one launch", () =>
    Effect.gen(function* () {
      const messages = yield* Queue.make<Schema.Json, Cause.Done>();
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
        // The CLI repeats `init` ahead of every turn with the same session id.
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
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk));
    }).pipe(Effect.scoped),
  );
  it.effect("closes a paused tool hook with its child scope even without a vendor abort", () =>
    Effect.gen(function* () {
      const messages = yield* Queue.make<Schema.Json, Cause.Done>();
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
      }).pipe(Scope.provide(owner), Effect.provide(claudeChildLayer), Effect.provide(sdk));
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
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
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
        Effect.provide(claudeChildLayer),
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
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
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
          assert(error instanceof UnknownModelError);
          assert.strictEqual(error.model, "claude-never-existed");
        }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
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
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
    );
  });

  it.effect("fails the session as agent work when Claude reports an unsuccessful result", () => {
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () =>
        scripted([
          { type: "system", subtype: "session_state_changed", state: "running" },
          {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "gate", task_type: "local_bash", description: "Run gate" }],
          },
          { type: "result", subtype: "error_max_turns", errors: ["ran out of turns"] },
        ]),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const session = yield* backend.launch(request());
        const error = yield* Effect.flip(session.result);
        assert(error instanceof AgentResultError);
        assert.strictEqual(error.message, "ran out of turns");
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
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
        assert(error instanceof SessionOperationError);
        assert.strictEqual(error.operation, "stream");
        assert.match(error.message, /closed without a result/u);
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
    );
  });
});
