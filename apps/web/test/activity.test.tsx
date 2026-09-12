import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentName } from "@usine/core/agent";
import { AgentSessionId, ParentSession } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { TranscriptSequence } from "@usine/engine/transcript";
import { Option } from "effect";
import { assert, describe, it } from "vitest";
import { describeActivity, elapsedActivity } from "../src/run-transcript/activity.tsx";
import type { TranscriptSession, TranscriptTool } from "../src/run-transcript/model.ts";

const startedAt = "2026-09-06T12:00:00.000Z";
const command: TranscriptTool = {
  _tag: "Tool",
  key: "command",
  sequence: TranscriptSequence.make(1),
  latestSequence: TranscriptSequence.make(1),
  receivedAt: startedAt,
  name: "bash",
  start: Option.some({ receivedAt: startedAt, input: { command: "pnpm test" } }),
  state: { _tag: "Running" },
};
const session: TranscriptSession = {
  _tag: "Session",
  key: "parent",
  sequence: TranscriptSequence.make(1),
  latestSequence: TranscriptSequence.make(1),
  receivedAt: startedAt,
  attemptId: AttemptId.make("attempt-1"),
  session: new ParentSession({
    id: AgentSessionId.make("parent"),
    agent: AgentName.make("developer"),
    brain: new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "high" }),
  }),
  status: "Live",
  held: false,
  paused: false,
  idle: false,
  entries: [command],
};

describe("current activity", () => {
  it("identifies the running command and its actual start time", () => {
    const activity = describeActivity(session);
    assert.strictEqual(activity.label, "Running command");
    assert.strictEqual(activity.detail, "pnpm test");
    assert.deepStrictEqual(activity.since, Option.some(startedAt));
  });

  it("identifies the file being read instead of a harness tool name", () => {
    const activity = describeActivity({
      ...session,
      entries: [
        {
          ...command,
          name: "Read",
          start: Option.some({ receivedAt: startedAt, input: { file_path: "src/run.ts" } }),
        },
      ],
    });
    assert.strictEqual(activity.label, "Reading file");
    assert.strictEqual(activity.detail, "src/run.ts");
  });

  it("clears the action when its result arrives or the session ends", () => {
    const completed = describeActivity({
      ...session,
      entries: [
        {
          ...command,
          state: {
            _tag: "Finished",
            receivedAt: startedAt,
            output: "Tests passed",
          },
        },
      ],
    });
    assert.strictEqual(completed.label, "Working");
    assert.strictEqual(completed.detail, "");
    assert(Option.isNone(completed.since));
    for (const status of ["Finished", "Stopped"] as const) {
      const ended = describeActivity({ ...session, status });
      assert.strictEqual(ended.label, status);
      assert.strictEqual(ended.detail, "");
      assert(Option.isNone(ended.since));
    }
  });

  it("reports elapsed time without negative values or inferring a stall", () => {
    const start = Date.parse(startedAt);
    assert.strictEqual(elapsedActivity(startedAt, start - 2_000), "0s");
    assert.strictEqual(elapsedActivity(startedAt, start + 18_900), "18s");
    assert.strictEqual(elapsedActivity(startedAt, start + 125_000), "2m 5s");
    assert.strictEqual(elapsedActivity(startedAt, start + 3_720_000), "1h 2m");
  });
});
