import { TranscriptEventView } from "@usine/orchestrator";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { mergeTranscript, Transcript } from "../src/run-transcript.tsx";

const event = (sequence: number, label: string, scope: "parent" | "child" | "channel" = "parent") =>
  new TranscriptEventView({
    sequence,
    attemptId: "attempt-31",
    receivedAt: "2026-09-01T12:00:00.000Z",
    scope,
    kind: "text-output",
    sessionId: scope === "channel" ? null : `${scope}-session`,
    parentId: scope === "child" ? "parent-session" : null,
    agent: "developer",
    label,
    detail: `${label} detail`,
    isError: false,
  });

describe("run transcript", () => {
  it("renders parent activity inline and groups a child's activity one level deep", () => {
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
    assert.match(markup, /Child activity.*2 events/);
    assert.ok(markup.indexOf("Parent update") < markup.indexOf("Child activity"));
    assert.ok(markup.indexOf("Child activity") < markup.indexOf("Channel notice"));
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
