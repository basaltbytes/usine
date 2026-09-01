import { Attempt } from "@usine/core";
import { TranscriptEventView } from "@usine/orchestrator";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { mergeTranscript, Transcript } from "../src/run-transcript.tsx";

const attemptId = Attempt.AttemptId.make("attempt-31");

const event = (
  sequence: number,
  label: string,
  scope: "parent" | "child" | "channel" = "parent",
  session = `${scope}-session`,
) =>
  new TranscriptEventView({
    sequence,
    attemptId,
    receivedAt: "2026-09-01T12:00:00.000Z",
    scope,
    kind: "text-output",
    sessionId: scope === "channel" ? null : session,
    parentId: scope === "child" ? "parent-session" : null,
    agent: scope === "child" ? `agent-${session}` : "developer",
    label,
    detail: `${label} detail`,
    isError: false,
  });

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
    assert.ok(markup.indexOf("activity") < markup.indexOf("Channel notice"));
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
    assert.ok(markup.indexOf("agent-child-a activity") < markup.indexOf("Parent update"));
    assert.ok(markup.indexOf("Parent update") < markup.indexOf("agent-child-b activity"));
  });

  it("merges transcript tails by sequence without replaying an existing event", () => {
    const first = event(1, "First");
    const second = event(2, "Second");
    const merged = mergeTranscript([second, first], [second, event(3, "Third")]);

    assert.deepStrictEqual(
      merged.map(({ sequence, label }) => [sequence, label]),
      [
        [1, "First"],
        [2, "Second"],
        [3, "Third"],
      ],
    );
  });
});
