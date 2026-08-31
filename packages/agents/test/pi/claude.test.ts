import { assert, describe, it } from "@effect/vitest";
import { Agent } from "@usine/core";
import { Effect, Layer, Stream } from "effect";
import {
  ChildBackend,
  ChildRequest,
  UnknownModelError,
  WorkingDirectory,
} from "../../src/index.ts";
import {
  ClaudeSdk,
  claudeChildLayer,
  type ClaudeQuery,
  type ClaudeQueryOptions,
  type ClaudeUserMessage,
} from "../../src/pi/claude.ts";

const request = (model = "claude-sonnet-4-6") =>
  new ChildRequest({
    session: new Agent.ChildSession({
      id: Agent.SessionId.make("child-1"),
      parentId: Agent.SessionId.make("parent-1"),
      agent: Agent.Name.make("developer"),
      brain: new Agent.BrainSpec({
        harness: "claude",
        model: Agent.ModelId.make(model),
        effort: "high",
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/repo"),
    prompt: "Implement the focused task.",
  });

const scripted = (
  messages: ReadonlyArray<unknown>,
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

    return Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* ChildBackend;
        const error = yield* Effect.flip(backend.launch(request("claude-never-existed")));
        assert(error instanceof UnknownModelError);
        assert.strictEqual(error.model, "claude-never-existed");
        assert.strictEqual(closed, true);
      }).pipe(Effect.provide(claudeChildLayer), Effect.provide(sdk)),
    );
  });
});
