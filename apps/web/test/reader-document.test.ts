import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  SessionFinished,
  TextOutput,
  ToolFinished,
  ToolStarted,
  type AgentSession,
} from "@usine/core/agent/session";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { TranscriptSequence } from "@usine/engine/transcript";
import {
  AgentFailureView,
  AttemptView,
  FailedAttemptView,
  FailedTranscriptView,
  InfraFailureView,
  TranscriptEventView,
} from "@usine/orchestrator/operator";
import { Option } from "effect";
import { assert, describe, it } from "vitest";
import {
  chapterCheckpoints,
  readerDocument,
  type ChapterRow,
} from "../src/run-transcript/document/model.ts";
import { checkpointText } from "../src/run-transcript/document/text.ts";
import { projectTranscript } from "../src/run-transcript/model.ts";

const brain = new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "medium" });
const parent = new ParentSession({
  id: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain,
});
const child = new ChildSession({
  id: AgentSessionId.make("child"),
  parentId: parent.id,
  agent: AgentName.make("developer"),
  brain,
});
const attemptId = AttemptId.make("attempt-1");
const at = (sequence: number) => new Date(Date.UTC(2026, 9, 15, 19, 31, sequence)).toISOString();
const record = (sequence: number, payload: TranscriptEventView["payload"]) =>
  new TranscriptEventView({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    receivedAt: at(sequence),
    direction: "outbound",
    payload,
  });
const said = (sequence: number, text: string, session: AgentSession = child) =>
  record(
    sequence,
    new AttemptChannel.SessionEvent({ event: new TextOutput({ session, text }) }),
  );
const delegation = [
  record(
    2,
    new AttemptChannel.SessionEvent({
      event: new ToolStarted({
        session: parent,
        callId: "delegate",
        tool: "subagent",
        input: { task: "Complete issue #247 end-to-end." },
      }),
    }),
  ),
];
const attempt = (outcome: AttemptView["outcome"]) =>
  new AttemptView({
    id: attemptId,
    number: AttemptNumber.make(1),
    worker: WorkerName.make("usine-worker-1"),
    brain,
    task: AttemptTask.make("Complete issue #247."),
    agent: AgentName.make("developer"),
    operatorIntervened: false,
    startedAt: at(0),
    outcome,
    endedAt: null,
    salvage: null,
  });
const document = (events: ReadonlyArray<TranscriptEventView>, attempts: ReadonlyArray<AttemptView>) =>
  readerDocument(projectTranscript(events, attempts), attempts, events);
const shown = (rows: ReadonlyArray<ChapterRow>) =>
  rows.flatMap((row) => (row._tag === "Message" ? [`${row.speaker.name}: ${row.text}`] : [row._tag]));

const report =
  "Baseline lint fails on this Worker.\n\nRecorded the [blocker on #247](https://github.com/basaltbytes/usine/issues/247).";

describe("repeated final messages", () => {
  it("shows a failed Attempt's final report once, as the failure note where the child said it", () => {
    const failure = new AgentFailureView({ message: report });
    const events = [
      record(1, new AttemptChannel.Started({ parentModel: ModelId.make("gpt-5") })),
      ...delegation,
      said(3, "I'll use the tackle-issue skill."),
      said(9, `[usine:blocked]\n\n${report}`),
      record(
        10,
        new AttemptChannel.SessionEvent({ event: new SessionFinished({ session: child }) }),
      ),
      said(11, `[usine:blocked]\n${report}`, parent),
      record(12, new FailedTranscriptView({ failure })),
    ];
    const chapter = document(events, [attempt(new FailedAttemptView({ failure }))]).chapters[0];
    assert.isDefined(chapter);
    assert.deepEqual(shown(chapter.rows), [
      "Delegation",
      "developer: I'll use the tackle-issue skill.",
      "Ending",
    ]);
    const ending = chapter.rows.at(-1);
    assert(ending?._tag === "Ending");
    assert.equal(ending.end._tag, "Failed");
    assert.deepEqual(ending.receivedAt, Option.some(at(9)));
    assert.equal(ending.speaker?.name, "developer");
    assert.equal(ending.key, "event:12");
  });

  it("leaves out the parent's copy of a child's message while the Attempt still runs", () => {
    const chapter = document(
      [
        said(3, "Tests pass; opening the pull request."),
        said(4, "Tests pass;   opening the pull request.", parent),
        said(5, "Waiting for CI.", parent),
      ],
      [attempt(null)],
    ).chapters[0];
    assert.isDefined(chapter);
    assert.isTrue(chapter.live);
    assert.deepEqual(shown(chapter.rows), [
      "developer: Tests pass; opening the pull request.",
      "Parent: Waiting for CI.",
    ]);
  });

  it("shows a succeeded Attempt's result once, as its outcome, with no separate finished block", () => {
    const summary = "Completed PR #320 finishing pass.\n\n- PR was not merged.";
    const events = [
      said(3, "Finishing pass for PR #320 is complete, with every check passing."),
      said(4, summary, parent),
      record(5, new AttemptChannel.Final({ result: new StepResult({ message: summary, facts: [] }) })),
    ];
    const chapter = document(events, [attempt(null)]).chapters[0];
    assert.isDefined(chapter);
    assert.isFalse(chapter.live);
    assert.deepEqual(shown(chapter.rows), [
      "developer: Finishing pass for PR #320 is complete, with every check passing.",
      "Ending",
    ]);
    const ending = chapter.rows.at(-1);
    assert(ending?._tag === "Ending" && ending.end._tag === "Succeeded");
    assert.deepEqual(ending.end.message, Option.some(summary));
    assert.equal(ending.speaker?.name, "Parent");
  });

  it("keeps the last message when the failure is not the Agent's own report", () => {
    const failure = new InfraFailureView({ message: "Worker disconnected" });
    const chapter = document(
      [said(3, "Worker disconnected"), record(4, new FailedTranscriptView({ failure }))],
      [attempt(new FailedAttemptView({ failure }))],
    ).chapters[0];
    assert.isDefined(chapter);
    assert.deepEqual(shown(chapter.rows), ["developer: Worker disconnected", "Ending"]);
  });

  it("ends an Attempt whose terminal envelope is not loaded with its recorded outcome", () => {
    const failure = new AgentFailureView({ message: "Blocked" });
    const chapter = document([], [attempt(new FailedAttemptView({ failure }))]).chapters[0];
    assert.isDefined(chapter);
    const ending = chapter.rows[0];
    assert(ending?._tag === "Ending");
    assert.equal(ending.key, `ending:${attemptId}`);
    assert(Option.isNone(ending.position));
  });
});

describe("checkpoints", () => {
  it("names a message by its first sentence as plain text on one line", () => {
    assert.equal(
      checkpointText(
        "#247 confirms that both schemas use the same pattern. I've updated the issue labels.",
      ),
      "#247 confirms that both schemas use the same pattern.",
    );
    assert.equal(
      checkpointText("[usine:blocked]\n\nBaseline **lint** and `knip` fail. Changing it needs sudo."),
      "Baseline lint and knip fail.",
    );
    assert.equal(
      checkpointText("## Plan\n\n1. Read the issue"),
      "Plan",
    );
    assert.equal(
      checkpointText("```bash\npnpm lint\n```\nSee the [log](https://example.com) for details."),
      "See the log for details.",
    );
    assert.equal(checkpointText("Version 1.5 is out"), "Version 1.5 is out");
  });

  it("lists each message under its session and marks blockers and failures", () => {
    const failure = new AgentFailureView({ message: "Baseline gate fails. No edits made." });
    const events = [
      said(3, "I'll start with the baseline. Then the change."),
      said(4, "Waiting on the developer.", parent),
      said(5, "[usine:blocked]\nThe gate is blocked by memory."),
      record(
        6,
        new AttemptChannel.SessionEvent({
          event: new ToolFinished({
            session: child,
            callId: "x",
            tool: "bash",
            output: "",
            isError: true,
          }),
        }),
      ),
      record(7, new FailedTranscriptView({ failure })),
    ];
    const chapter = document(events, [attempt(new FailedAttemptView({ failure }))]).chapters[0];
    assert.isDefined(chapter);
    const childKey = chapter.sessions.find(({ session }) => session.id === child.id)?.key;
    const parentKey = chapter.sessions.find(({ session }) => session.id === parent.id)?.key;
    assert.deepEqual(
      chapterCheckpoints(chapter).map(({ text, tone, sessionKey }) => [text, tone, sessionKey]),
      [
        ["I'll start with the baseline.", "plain", childKey],
        ["Waiting on the developer.", "plain", parentKey],
        ["The gate is blocked by memory.", "failed", childKey],
        ["Baseline gate fails.", "failed", null],
      ],
    );
    assert.equal(chapterCheckpoints(chapter)[2]?.key, "event:5");
  });
});
