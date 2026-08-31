import { assert, describe, it } from "@effect/vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@usine/core";
import { Effect, Option, Stream } from "effect";
import { ChildBackend, SessionResult, WorkingDirectory } from "../../src/index.ts";
import { createSubagentsExtension } from "../../src/pi/subagents.ts";

describe("owned Pi subagents extension", () => {
  it("launches an isolated first-level child with the rostered persona", async () => {
    const agent = new Agent.Agent({
      name: Agent.Name.make("developer"),
      harness: "claude",
      model: Agent.ModelId.make("claude-sonnet-4-6"),
      effort: "high",
      parentModel: Option.none(),
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
    let childRequest: Parameters<ChildBackend["Service"]["launch"]>[0] | undefined;
    const child = ChildBackend.of({
      launch: (request) => {
        childRequest = request;
        return Effect.succeed({
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
    const activities: Array<Agent.Activity> = [];
    let registered: ToolDefinition | undefined;
    const extension = createSubagentsExtension({
      agent,
      backend: child,
      cwd: WorkingDirectory.make("/workspace/repo"),
      emit: (activity) => Effect.sync(() => activities.push(activity)),
      parentId: parent.id,
    });
    await extension({ registerTool: (tool) => (registered = tool) } as ExtensionAPI);
    assert(registered !== undefined);

    const result = await registered.execute(
      "tool-1",
      { task: "Add interrupt propagation." },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    assert.strictEqual(result.content[0]?.type, "text");
    assert.strictEqual(result.content[0]?.text, "child done");
    assert.strictEqual(childRequest?.session.parentId, parent.id);
    assert.match(childRequest?.prompt ?? "", /Implement focused TypeScript changes/u);
    assert.match(childRequest?.prompt ?? "", /— usine agent: developer/u);
    assert.deepStrictEqual(
      activities.map((activity) => activity._tag),
      ["SessionStarted", "TextOutput", "SessionFinished"],
    );
  });
});
