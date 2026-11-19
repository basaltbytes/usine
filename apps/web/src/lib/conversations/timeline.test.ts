import { assert, expect, it } from "vitest";
import {
  ada,
  answered,
  conversationOf,
  running,
  stepEvents,
  supervisorCalls,
  turnEvents,
} from "~/lib/conversations/fixture";
import { messageRequest, retryRequest } from "~/lib/conversations/request-fixture";
import { burstSummary, currentCall } from "~/lib/runs/transcript/grouping/summary";
import { conversationTimeline, type TurnStep } from "./timeline";

const stepStates = (steps: ReadonlyArray<TurnStep> | undefined) =>
  steps?.map((step) =>
    step._tag === "Tools"
      ? step.calls.map((call) => call.state._tag)
      : step._tag === "Request"
        ? `request ${step.request.id}`
        : step.text,
  );

it("pairs each tool call's result by call ID and keeps a running call open", () => {
  const live = conversationOf([
    { turn: "t-1", member: ada, text: "Why?", minute: 1, state: running(1) },
  ]);
  const [started] = conversationTimeline(live, turnEvents("t-1", 1, false));
  expect(stepStates(started?.activity)).toEqual([
    "Checking the overview for run 7431.",
    ["Running"],
  ]);
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
  expect(stepStates(finished?.activity)).toEqual([["Finished"]]);
  expect(finished?.reply?.body).toBe("Checking the overview for run 7431.");
});

it("groups the tool calls between two texts and keeps a group's key as calls join it", () => {
  const live = conversationOf([
    { turn: "t-1", member: ada, text: "Why?", minute: 1, state: running(1) },
  ]);
  const steps = [
    "Looking at the run.",
    ...supervisorCalls(2),
    "Now the loop.",
    ...supervisorCalls(1),
  ];
  const [entry] = conversationTimeline(live, stepEvents("t-1", 1, steps));
  expect(stepStates(entry?.activity)).toEqual([
    "Looking at the run.",
    ["Finished", "Finished"],
    "Now the loop.",
    ["Finished"],
  ]);
  const [grown] = conversationTimeline(
    live,
    stepEvents("t-1", 1, [...steps, { tool: "Grep", input: { pattern: "gate" } }]),
  );
  expect(grown?.activity.map((step) => step.key)).toEqual(entry?.activity.map((step) => step.key));
});

it("places a permission request at the call that made it, between the calls around it", () => {
  const record = conversationOf([
    { turn: "t-1", member: ada, text: "Retry it", minute: 1, state: answered(1), answer: "Asked." },
  ]);
  const steps = [
    ...supervisorCalls(1),
    { tool: "mcp__usine__retry", input: { runId: "run-7431" } },
    ...supervisorCalls(2),
  ];
  const elsewhere = messageRequest({ toolCall: null });
  const [entry] = conversationTimeline(
    { ...record, requests: [retryRequest(), elsewhere] },
    stepEvents("t-1", 1, steps),
  );
  expect(stepStates(entry?.activity)).toEqual([
    ["Finished"],
    "request r-1",
    ["Finished", "Finished"],
    "request r-2",
  ]);
});

it("shows a turn of 40 calls as one group that counts its failures and names its running call", () => {
  const live = conversationOf([
    { turn: "t-1", member: ada, text: "Why?", minute: 1, state: running(1) },
  ]);
  const calls = [
    ...supervisorCalls(38),
    { tool: "mcp__usine__run", input: { run: "run-9999" }, outcome: "failed" as const },
    {
      tool: "Read",
      input: { file_path: "packages/config/src/loop.ts" },
      outcome: "running" as const,
    },
  ];
  const [entry] = conversationTimeline(live, stepEvents("t-1", 1, calls));
  expect(entry?.activity).toHaveLength(1);
  const group = entry?.activity[0];
  assert(group?._tag === "Tools");
  expect(group.calls).toHaveLength(40);
  expect(group.calls.filter((call) => call.state._tag === "Error")).toHaveLength(1);
  expect(currentCall(group.calls)?.name).toBe("Read");
  expect(burstSummary({ tools: group.calls })).toBe(
    "16 tool calls · read approval.ts, loop.ts · 8 more calls",
  );
});
