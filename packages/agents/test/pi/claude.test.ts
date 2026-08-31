import { assert, describe, it } from "@effect/vitest";
import { Agent } from "@usine/core";
import { Effect, Layer, Schema, Stream } from "effect";
import {
  AgentResultError,
  ChildBackend,
  ChildRequest,
  SessionOperationError,
  UnknownModelError,
  UnsupportedHarnessError,
  WorkingDirectory,
} from "../../src/index.ts";
import {
  ClaudeSdk,
  claudeChildLayer,
  type ClaudeQuery,
  type ClaudeQueryOptions,
  type ClaudeUserMessage,
} from "../../src/pi/claude.ts";

const request = (
  model = "claude-sonnet-4-6",
  options?: { readonly harness?: Agent.Harness; readonly effort?: Agent.Effort },
) =>
  new ChildRequest({
    session: new Agent.ChildSession({
      id: Agent.SessionId.make("child-1"),
      parentId: Agent.SessionId.make("parent-1"),
      agent: Agent.Name.make("developer"),
      brain: new Agent.BrainSpec({
        harness: "claude",
        model: Agent.ModelId.make(model),
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
    for (const message of messages) yield message;
  },
});

describe("Claude child backend", () => {
  it.effect("streams normalized activity and runs headlessly with the declared model", () => {
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
        assert.strictEqual(options?.model, "claude-sonnet-4-6");
        assert.strictEqual(options?.effort, "high");
        assert.strictEqual(options?.permissionMode, "bypassPermissions");
        assert.strictEqual(options?.allowDangerouslySkipPermissions, true);
        assert.strictEqual(options?.persistSession, false);
        assert.deepStrictEqual(options?.settingSources, ["user"]);
        const first = yield* Effect.promise(() => input![Symbol.asyncIterator]().next());
        assert.strictEqual(first.value?.message.content, "Implement the focused task.");
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

  it.effect("rejects a non-Claude harness before opening the SDK", () => {
    let opened = 0;
    const sdk = Layer.succeed(ClaudeSdk)({
      open: () => {
        opened += 1;
        return scripted([]);
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const error = yield* Effect.flip(backend.launch(request(undefined, { harness: "codex" })));
        assert(error instanceof UnsupportedHarnessError);
        assert.strictEqual(error.harness, "codex");
        assert.strictEqual(opened, 0);
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
    );
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
        scripted([{ type: "result", subtype: "error_max_turns", errors: ["ran out of turns"] }]),
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
