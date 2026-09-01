import { Agent, Attempt, AttemptChannel } from "@usine/core";
import {
  TranscriptEventView,
  TranscriptPageCursor,
  TranscriptCursor,
} from "@usine/orchestrator";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import {
  mergeTranscript,
  replaceEarlierCursor,
  Transcript,
} from "../src/run-transcript.tsx";

const attemptId = Attempt.AttemptId.make("attempt-31");
const brain = new Agent.BrainSpec({
  harness: "codex",
  model: Agent.ModelId.make("gpt-5"),
  effort: "high",
});

const event = (
  sequence: number,
  text: string,
  scope: "parent" | "child" | "channel" = "parent",
  session = `${scope}-session`,
) => {
  const agent = Agent.Name.make(
    scope === "child" ? `agent-${session}` : "developer",
  );
  const sessionView =
    scope === "child"
      ? new Agent.ChildSession({
          id: Agent.SessionId.make(session),
          parentId: Agent.SessionId.make("parent-session"),
          agent,
          brain,
        })
      : new Agent.ParentSession({
          id: Agent.SessionId.make(session),
          agent,
          brain,
        });
  return new TranscriptEventView({
    sequence: TranscriptCursor.make(sequence),
    attemptId,
    receivedAt: "2026-09-01T12:00:00.000Z",
    direction: "outbound",
    payload:
      scope === "channel"
        ? new AttemptChannel.Started({
            parentModel: Agent.ModelId.make("gpt-5"),
          })
        : new AttemptChannel.SessionEvent({
            event: new Agent.TextOutput({ session: sessionView, text }),
          }),
  });
};

describe("run transcript", () => {
  it("renders parent activity inline and groups each child session one level deep", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        events={[
          event(1, "Parent update"),
          event(2, "Child tool started", "child"),
          event(3, "Child tool finished", "child"),
          event(4, "Channel notice", "channel"),
        ]}
      />,
    );

    assert.strictEqual((markup.match(/<details/g) ?? []).length, 1);
    assert.match(markup, /agent-child-session activity.*2 events/);
    assert.ok(markup.indexOf("Parent update") < markup.indexOf("activity"));
    assert.ok(markup.indexOf("activity") < markup.indexOf("Attempt started"));
  });

  it("keeps concurrent child sessions distinct, each anchored at its own first event", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        events={[
          event(1, "First child says hello", "child", "child-a"),
          event(2, "Parent update"),
          event(3, "Second child says hello", "child", "child-b"),
        ]}
      />,
    );

    assert.strictEqual((markup.match(/<details/g) ?? []).length, 2);
    assert.ok(
      markup.indexOf("agent-child-a activity") <
        markup.indexOf("Parent update"),
    );
    assert.ok(
      markup.indexOf("Parent update") <
        markup.indexOf("agent-child-b activity"),
    );
  });

  it("merges transcript tails by sequence without replaying an existing event", () => {
    const first = event(1, "First");
    const second = event(2, "Second");
    const merged = mergeTranscript(
      [second, first],
      [second, event(3, "Third")],
    );

    assert.deepStrictEqual(
      merged.map(({ sequence, payload }) => [
        sequence,
        payload._tag === "SessionEvent" && payload.event._tag === "TextOutput"
          ? payload.event.text
          : payload._tag,
      ]),
      [
        [1, "First"],
        [2, "Second"],
        [3, "Third"],
      ],
    );
  });

  it("replaces only the cursor for the Attempt whose earlier page was loaded", () => {
    const firstAttempt = Attempt.AttemptId.make("attempt-1");
    const secondAttempt = Attempt.AttemptId.make("attempt-2");
    const cursors = [
      new TranscriptPageCursor({
        attemptId: firstAttempt,
        before: TranscriptCursor.make(100),
      }),
      new TranscriptPageCursor({
        attemptId: secondAttempt,
        before: TranscriptCursor.make(200),
      }),
    ];
    const replaced = replaceEarlierCursor(cursors, secondAttempt, [
      new TranscriptPageCursor({
        attemptId: secondAttempt,
        before: TranscriptCursor.make(50),
      }),
    ]);

    assert.deepStrictEqual(
      replaced.map(({ attemptId, before }) => [attemptId, before]),
      [
        [secondAttempt, 50],
        [firstAttempt, 100],
      ],
    );
  });
});
