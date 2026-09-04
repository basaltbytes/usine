import { assert, describe, it } from "@effect/vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@usine/core";
import { Effect, Logger, Option, Stream } from "effect";
import {
  type AgentSessionError,
  ChildBackend,
  ChildSessionBudgetExceededError,
  SessionResult,
  WorkingDirectory,
} from "../../src/index.ts";
import { createSubagentsExtension } from "../../src/pi/subagents.ts";

const agent = new Agent.Agent({
  name: Agent.Name.make("developer"),
  brain: new Agent.BrainSpec({
    harness: "claude",
    model: Agent.ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: Agent.Persona.make("Implement focused TypeScript changes."),
});
const parent = new Agent.ParentSession({
  id: Agent.SessionId.make("parent-1"),
  agent: agent.name,
  brain: new Agent.BrainSpec({
    harness: "pi",
    model: Agent.ModelId.make("anthropic/claude-opus-4-6"),
    effort: "high",
  }),
});
// SAFETY: the owned subagent tool does not read ExtensionContext.
const context = {} as ExtensionContext;

describe("owned Pi subagents extension", () => {
  it("launches an isolated first-level child with the rostered persona", async () => {
    let childRequest: Parameters<ChildBackend["Service"]["launch"]>[0] | undefined;
    const child = ChildBackend.of({
      launch: (request) => {
        childRequest = request;
        return Effect.succeed({
          session: request.session,
          events: Stream.make(
            new Agent.SessionStarted({ session: request.session }),
            new Agent.TextOutput({ session: request.session, text: "working" }),
            new Agent.SessionFinished({ session: request.session }),
          ),
          result: Effect.succeed(new SessionResult({ message: "child done" })),
          steer: () => Effect.void,
          interrupt: Effect.void,
        });
      },
    });
    const events: Array<Agent.SessionEvent> = [];
    const logs: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      logs.push(message);
    });
    let registered: ToolDefinition | undefined;
    const extension = createSubagentsExtension({
      agent,
      backend: child,
      cwd: WorkingDirectory.make("/workspace/repo"),
      emit: (event) => Effect.sync(() => events.push(event)),
      maxChildren: Agent.ChildSessionBudget.make(4),
      onBudgetExceeded: () => Effect.void,
      parentId: parent.id,
      run: (program) => Effect.runPromise(program.pipe(Effect.withLogger(logger))),
    });
    // SAFETY: this extension only calls registerTool; all other ExtensionAPI members are unused.
    await extension({ registerTool: (tool) => (registered = tool) } as ExtensionAPI);
    assert(registered !== undefined);

    const result = await registered.execute(
      "tool-1",
      { task: "Add interrupt propagation." },
      undefined,
      undefined,
      context,
    );
    assert.strictEqual(result.content[0]?.type, "text");
    assert.strictEqual(result.content[0]?.text, "child done");
    assert.strictEqual(childRequest?.session.parentId, parent.id);
    assert.match(childRequest?.prompt ?? "", /Implement focused TypeScript changes/u);
    assert.match(childRequest?.prompt ?? "", /— usine agent: developer/u);
    assert.deepStrictEqual(
      logs.find((message) => Array.isArray(message) && message[0] === "Spawning child session"),
      [
        "Spawning child session",
        {
          attemptedChildren: 1,
          maxChildren: 4,
          taskExcerpt: "Add interrupt propagation.",
        },
      ],
    );
    assert.deepStrictEqual(
      events.map((event) => event._tag),
      ["SessionStarted", "TextOutput", "SessionFinished"],
    );
  });

  it("rejects a spawn past the budget before launching and reports it to the parent", async () => {
    let launches = 0;
    const child = ChildBackend.of({
      launch: (request) => {
        launches += 1;
        return Effect.succeed({
          session: request.session,
          events: Stream.empty,
          result: Effect.succeed(new SessionResult({ message: "child done" })),
          steer: () => Effect.void,
          interrupt: Effect.void,
        });
      },
    });
    const reported: Array<ChildSessionBudgetExceededError> = [];
    const failures: Array<AgentSessionError> = [];
    const logs: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      logs.push(message);
    });
    let registered: ToolDefinition | undefined;
    const extension = createSubagentsExtension({
      agent,
      backend: child,
      cwd: WorkingDirectory.make("/workspace/repo"),
      emit: () => Effect.void,
      maxChildren: Agent.ChildSessionBudget.make(1),
      onBudgetExceeded: (error) => Effect.sync(() => reported.push(error)),
      parentId: parent.id,
      run: (program) =>
        Effect.runPromise(
          program.pipe(
            Effect.tapError((failure) => Effect.sync(() => failures.push(failure))),
            Effect.withLogger(logger),
          ),
        ),
    });
    // SAFETY: this extension only calls registerTool; all other ExtensionAPI members are unused.
    await extension({ registerTool: (tool) => (registered = tool) } as ExtensionAPI);
    assert(registered !== undefined);

    await registered.execute("tool-1", { task: "First child." }, undefined, undefined, context);
    let rejected = false;
    await registered
      .execute(
        "tool-2",
        { task: `  Second\n\tchild ${"x".repeat(200)}` },
        undefined,
        undefined,
        context,
      )
      .then(
        () => {},
        () => {
          rejected = true;
        },
      );

    assert.strictEqual(rejected, true);
    assert.strictEqual(launches, 1);
    const failure = failures[0];
    assert(failure instanceof ChildSessionBudgetExceededError);
    assert.strictEqual(failure.maxChildren, 1);
    assert.strictEqual(failure.attemptedChildren, 2);
    assert.deepStrictEqual(reported, [failure]);
    assert.deepStrictEqual(
      logs.find(
        (message) => Array.isArray(message) && message[0] === "Child session budget exceeded",
      ),
      [
        "Child session budget exceeded",
        {
          attemptedChildren: 2,
          maxChildren: 1,
          parentSessionId: "parent-1",
          taskExcerpt: `Second child ${"x".repeat(147)}…`,
        },
      ],
    );
  });
});
