import { DateTime } from "effect";
import { expect, it } from "vitest";
import {
  ada,
  answered,
  conversationOf,
  grace,
  queued,
  running,
  turnEvents,
} from "~/lib/conversations/fixture";
import { conversationTimeline, isPending, withPendingPost } from "./timeline";

it("pairs each tool call's result by call ID and keeps a running call open", () => {
  const live = conversationOf([
    { turn: "t-1", member: ada, text: "Why?", minute: 1, state: running(1) },
  ]);
  const [started] = conversationTimeline(live, turnEvents("t-1", 1, false));
  expect(
    started?.activity.map((step) => (step._tag === "Tool" ? step.call.state._tag : step.text)),
  ).toEqual(["Checking the overview for run 7431.", "Running"]);
  const done = conversationOf([
    {
      turn: "t-1",
      member: ada,
      text: "Why?",
      minute: 1,
      state: answered(1),
      answer: "Checking the overview for run 7431.",
    },
  ]);
  const [finished] = conversationTimeline(done, turnEvents("t-1", 1, true));
  // The text that repeats the answer shows once, as the answer.
  expect(
    finished?.activity.map((step) => (step._tag === "Tool" ? step.call.state._tag : step.text)),
  ).toEqual(["Finished"]);
  expect(finished?.reply?.body).toBe("Checking the overview for run 7431.");
});

it("marks a turn queued behind an open one, and a pending post until the server answers", () => {
  const record = conversationOf([
    { turn: "t-1", member: ada, text: "First", minute: 1, state: running(1) },
    { turn: "t-2", member: grace, text: "Second", minute: 2, state: queued },
  ]);
  expect(conversationTimeline(record, []).map(({ behind }) => behind)).toEqual([false, true]);
  const pending = withPendingPost(
    record,
    "Third",
    ada,
    DateTime.makeUnsafe(Date.UTC(2026, 10, 17, 9, 3)),
  );
  const timeline = conversationTimeline(pending, []);
  expect(timeline.map(({ message }) => message?.body)).toEqual(["First", "Second", "Third"]);
  expect(timeline.map(({ turn }) => isPending(turn))).toEqual([false, false, true]);
});
