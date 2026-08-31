import { assert, describe, it } from "@effect/vitest";
import { Agent, Attempt, AttemptChannel, Repository } from "@usine/core";
import { Effect, Layer, Option, Stream } from "effect";
import {
  AgentRuntime,
  ChildBackend,
  LaunchRequest,
  UnknownModelError,
  WorkingDirectory,
} from "../../src/index.ts";
import {
  PiSdk,
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
});
