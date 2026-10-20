import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  ProviderRecovered,
  ProviderRetries,
  ProviderRetrying,
  SessionFinished,
  TextOutput,
  ToolFinished,
  ToolStarted,
  type AgentSession,
} from "@usine/core/agent/session";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { StepResult } from "@usine/core/step/result";
import { GitHubLabelName } from "@usine/config/label";
import { SshDestination, WorkerName } from "@usine/core/worker";
import { TranscriptSequence } from "@usine/engine/transcript";
import {
  AgentFailureView,
  AttemptView,
  CommentedView,
  LabelAddedView,
  LabelRemovedView,
  LabelView,
  FailedAttemptView,
  FailedTranscriptView,
  InfraFailureView,
  TranscriptEventView,
  SshWorkerAccess,
} from "@usine/orchestrator/operator";
import { DateTime, Option } from "effect";
import { assert, describe, it } from "vitest";
import { clockLabel } from "../src/operator-copy.ts";
import { withGitHubChanges } from "../src/run-transcript/document/github-changes.ts";
import {
  chapterCheckpoints,
  outlineEntries,
  readerDocument,
  readingOrder,
  readingPlace,
  type ChapterRow,
} from "../src/run-transcript/document/model.ts";
import { errorTally } from "../src/run-transcript/navigation/model.ts";
import { checkpointLabel, checkpointText } from "../src/run-transcript/document/text.ts";
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
  record(sequence, new AttemptChannel.SessionEvent({ event: new TextOutput({ session, text }) }));
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
    workerAccess: new SshWorkerAccess({
      destination: SshDestination.make("usine-worker-1"),
      port: null,
    }),
    brain,
    task: AttemptTask.make("Complete issue #247."),
    agent: AgentName.make("developer"),
    operatorIntervened: false,
    startedAt: at(0),
    outcome,
    endedAt: null,
    salvage: null,
  });
const document = (
  events: ReadonlyArray<TranscriptEventView>,
  attempts: ReadonlyArray<AttemptView>,
) => readerDocument(projectTranscript(events, attempts), attempts, events);
const shown = (rows: ReadonlyArray<ChapterRow>) =>
  rows.flatMap((row) =>
    row._tag === "Message" ? [`${row.speaker.name}: ${row.text}`] : [row._tag],
  );

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
      record(
        5,
        new AttemptChannel.Final({ result: new StepResult({ message: summary, facts: [] }) }),
      ),
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
      checkpointText(
        "[usine:blocked]\n\nBaseline **lint** and `knip` fail. Changing it needs sudo.",
      ),
      "Baseline lint and knip fail.",
    );
    assert.equal(
      checkpointText("[usine:failed]\nCodex turn failed: stream closed."),
      "Codex turn failed: stream closed.",
    );
    assert.equal(checkpointText("## Plan\n\n1. Read the issue"), "Plan");
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

  it("folds each run of one session's turns into one outline entry and keeps marked rows on their own", () => {
    const failure = new AgentFailureView({ message: "The gate fails. No edits made." });
    const steer = new TranscriptEventView({
      sequence: TranscriptSequence.make(7),
      attemptId,
      receivedAt: at(7),
      direction: "inbound",
      payload: new AttemptChannel.Steer({ message: "Use the deploy key. It is in the vault." }),
    });
    const events = [
      said(3, "Reading the issue.", parent),
      said(4, "Delegating the change.", parent),
      said(5, "Running the baseline."),
      said(6, "[usine:blocked]\nThe gate is blocked by memory."),
      steer,
      record(
        8,
        new AttemptChannel.WorkerUnresponsive({
          worker: WorkerName.make("usine-worker-1"),
          lastAnsweredAt: DateTime.makeUnsafe(at(7)),
          reason: "No answer within 45 seconds",
        }),
      ),
      said(9, "Retrying with more memory."),
      said(10, "The gate passes now."),
      record(11, new FailedTranscriptView({ failure })),
    ];
    const chapter = document(events, [attempt(new FailedAttemptView({ failure }))]).chapters[0];
    assert.isDefined(chapter);
    assert.deepEqual(
      outlineEntries(chapter).map((entry) =>
        entry._tag === "Turns"
          ? `${entry.speaker}: ${entry.turns.map(({ text }) => text).join(" | ")}`
          : `[${entry.checkpoint.kind} ${entry.checkpoint.tone}] ${entry.checkpoint.speaker ?? "-"}: ${entry.checkpoint.text}`,
      ),
      [
        "Parent: Reading the issue. | Delegating the change.",
        "developer: Running the baseline.",
        "[blocker failed] developer: The gate is blocked by memory.",
        "[operator plain] Operator: Use the deploy key.",
        `[notice warning] -: usine-worker-1 silent since ${clockLabel(at(7))}.`,
        "developer: Retrying with more memory. | The gate passes now.",
        "[ending failed] -: The gate fails.",
      ],
    );
  });

  it("labels a long sentence at a clause or a whole word, never mid-word", () => {
    assert.equal(checkpointLabel("Blocker posted on #247."), "Blocker posted on #247.");
    assert.equal(
      checkpointLabel("Tests pass on main, so the change can start now."),
      "Tests pass on main",
    );
    assert.equal(
      checkpointLabel(
        "The baseline gate is blocked by the Worker's memory configuration: Oxc requests a buffer.",
      ),
      "The baseline gate is blocked by…",
    );
    assert.equal(
      checkpointLabel(
        "I'll use the tackle-issue skill to implement #247, run the required checks.",
      ),
      "I'll use the tackle-issue skill…",
    );
    assert.equal(
      checkpointLabel("Lint, formatting, knip, build, and type checks passed."),
      "Lint, formatting, knip, build…",
    );
    assert.equal(
      checkpointLabel("Antidisestablishmentarianismwithoutanyspaces ends here."),
      "Antidisestablishmentarianismwithoutanyspaces…",
    );
  });
});

describe("error count", () => {
  const call = (sequence: number, callId: string, isError: boolean) => [
    record(
      sequence,
      new AttemptChannel.SessionEvent({
        event: new ToolStarted({
          session: child,
          callId,
          tool: "bash",
          input: { command: "pnpm lint" },
        }),
      }),
    ),
    record(
      sequence + 1,
      new AttemptChannel.SessionEvent({
        event: new ToolFinished({ session: child, callId, tool: "bash", output: "", isError }),
      }),
    ),
  ];
  const tally = (
    events: ReadonlyArray<TranscriptEventView>,
    attempts: ReadonlyArray<AttemptView>,
  ) => {
    const counted = errorTally(document(events, attempts));
    return {
      errors: counted.errors.map(({ key }) => key),
      recovered: counted.recovered.map(({ key }) => key),
    };
  };

  it("counts failed Attempts and blockers as errors and tool failures the Agent went on from as recovered", () => {
    const failure = new InfraFailureView({ message: "Worker disconnected" });
    const second = AttemptId.make("attempt-2");
    const retried = (event: TranscriptEventView) =>
      new TranscriptEventView({ ...event, attemptId: second });
    const events = [
      ...call(3, "lint", true),
      said(5, "Lint failed; fixing the import."),
      ...call(6, "lint-again", false),
      ...call(8, "push", true),
      record(10, new FailedTranscriptView({ failure })),
      retried(said(11, "[usine:blocked]\nThe registry rejects the token.")),
      ...call(12, "build", true).map(retried),
      retried(said(14, "Built after a clean install.")),
    ];
    const counted = tally(events, [
      attempt(new FailedAttemptView({ failure })),
      new AttemptView({ ...attempt(null), id: second, number: AttemptNumber.make(2) }),
    ]);
    // The failed push is the last thing the first Attempt did, so its failure counts it.
    const toolKey = (attempt: AttemptId, callId: string) =>
      JSON.stringify([attempt, child.id, callId]);
    assert.deepEqual(counted, {
      errors: ["event:10", "event:11"],
      recovered: [toolKey(attemptId, "lint"), toolKey(second, "build")],
    });
  });

  it("counts a refused operator message and a connectivity warning only while it is open", () => {
    const refused = record(
      4,
      new AttemptChannel.InterventionRejected({
        inputSequence: AttemptChannel.Sequence.make(1),
        intervention: new AttemptChannel.Intervention({
          operator: "Philippe",
          target: new AttemptChannel.ChildTarget({ sessionId: child.id }),
          action: new AttemptChannel.OperatorMessage({ message: "Stop and push." }),
        }),
        message: "The child already finished.",
      }),
    );
    const silent = record(
      5,
      new AttemptChannel.WorkerUnresponsive({
        worker: WorkerName.make("usine-worker-1"),
        lastAnsweredAt: DateTime.makeUnsafe(at(4)),
        reason: "No answer within 45 seconds",
      }),
    );
    const live = tally([said(2, "Working."), refused, silent], [attempt(null)]);
    assert.deepEqual(live, { errors: ["event:4", "event:5"], recovered: [] });
    const answered = tally(
      [
        said(2, "Working."),
        silent,
        record(
          6,
          new AttemptChannel.WorkerResponsive({
            worker: WorkerName.make("usine-worker-1"),
            lastAnsweredAt: DateTime.makeUnsafe(at(4)),
          }),
        ),
      ],
      [attempt(null)],
    );
    assert.deepEqual(answered, { errors: [], recovered: [] });
  });
});

describe("reading place", () => {
  const failure = new AgentFailureView({ message: "Blocked" });
  const second = AttemptId.make("attempt-2");
  const events = [
    said(3, "First message."),
    said(4, "Second message."),
    record(5, new FailedTranscriptView({ failure })),
    new TranscriptEventView({
      sequence: TranscriptSequence.make(6),
      attemptId: second,
      receivedAt: at(6),
      direction: "outbound",
      payload: new AttemptChannel.SessionEvent({
        event: new TextOutput({ session: child, text: "Retry message." }),
      }),
    }),
  ];
  const attempts = [
    attempt(new FailedAttemptView({ failure })),
    new AttemptView({ ...attempt(null), id: second, number: AttemptNumber.make(2) }),
  ];
  const order = readingOrder(document(events, attempts));

  it("follows the first row in view and marks the last checkpoint at or above it", () => {
    assert.deepEqual(readingPlace(order, ["event:4", "event:5"]), {
      attemptId,
      checkpointKey: "event:4",
    });
    assert.deepEqual(readingPlace(order, [`attempt:${second}`, "event:6"]), {
      attemptId: second,
      checkpointKey: null,
    });
    assert.deepEqual(readingPlace(order, ["event:6", `activity:${second}`]), {
      attemptId: second,
      checkpointKey: "event:6",
    });
    assert.isNull(readingPlace(order, []));
  });
});

describe("GitHub changes", () => {
  const command = (sequence: number, callId: string, finished: boolean) =>
    record(
      sequence,
      new AttemptChannel.SessionEvent({
        event: finished
          ? new ToolFinished({
              session: child,
              callId,
              tool: "command",
              output: "",
              isError: false,
            })
          : new ToolStarted({
              session: child,
              callId,
              tool: "command",
              input: { command: "/bin/bash -lc 'gh issue edit 247'" },
            }),
      }),
    );
  const label = (name: string, color: string) =>
    new LabelView({ name: GitHubLabelName.make(name), color, description: null });
  const blocker = "https://github.com/basaltbytes/usine/issues/247#issuecomment-6201011438";
  const failure = new AgentFailureView({
    message: `Baseline lint fails.\n\nRecorded the [signed blocker on #247](${blocker}) and removed \`agent-in-progress\`.`,
  });
  const events = [
    record(1, new AttemptChannel.Started({ parentModel: ModelId.make("gpt-5") })),
    ...delegation,
    said(3, "I'll use the tackle-issue skill."),
    command(4, "claim", false),
    command(6, "claim", true),
    said(7, "The baseline gate is blocked."),
    command(8, "blocker", false),
    command(10, "blocker", true),
    said(11, `[usine:blocked]\n${failure.message}`),
    record(12, new FailedTranscriptView({ failure })),
  ];
  const changes = [
    new LabelRemovedView({ at: at(5), label: label("ready-for-agent", "1f883d") }),
    new LabelAddedView({ at: at(5), label: label("agent-in-progress", "fbca04") }),
    new CommentedView({ at: at(9), url: blocker }),
    new LabelRemovedView({ at: at(9), label: label("agent-in-progress", "fbca04") }),
    new LabelAddedView({ at: at(9), label: label("needs-operator", "d93f0b") }),
  ];
  const described = (rows: ReadonlyArray<ChapterRow>) =>
    rows.map((row) => {
      if (row._tag === "Message") return `${row.speaker.name}: ${row.text}`;
      if (row._tag !== "GitHubChange") return row._tag;
      if (row.change._tag !== "Labels") return `GitHub ${row.change._tag} ${row.change.url}`;
      const names = (labels: ReadonlyArray<LabelView>) => labels.map(({ name }) => name).join(" ");
      return `GitHub removed [${names(row.change.removed)}] added [${names(row.change.added)}]`;
    });
  const failed = [attempt(new FailedAttemptView({ failure }))];

  it("follows the burst that made each change, swaps labels on one line, and leaves the outcome's own words to it", () => {
    const chapter = withGitHubChanges(
      document(events, failed),
      new Map([[attemptId, changes]]),
      new Set(),
    ).chapters[0];
    assert.isDefined(chapter);
    assert.deepEqual(described(chapter.rows), [
      "Delegation",
      "developer: I'll use the tackle-issue skill.",
      "Burst",
      "GitHub removed [ready-for-agent] added [agent-in-progress]",
      "developer: The baseline gate is blocked.",
      "Burst",
      "GitHub removed [] added [needs-operator]",
      "Ending",
    ]);
  });

  it("waits for earlier activity before placing a change made before the first loaded row", () => {
    const chapter = withGitHubChanges(
      document(events.slice(5), failed),
      new Map([[attemptId, changes]]),
      new Set([attemptId]),
    ).chapters[0];
    assert.isDefined(chapter);
    assert.deepEqual(described(chapter.rows), [
      "developer: The baseline gate is blocked.",
      "Burst",
      "GitHub removed [] added [needs-operator]",
      "Ending",
    ]);
  });
});

describe("connectivity", () => {
  const retry = (sequence: number, retries: number, message: string) =>
    record(
      sequence,
      new AttemptChannel.SessionEvent({
        event: new ProviderRetrying({
          session: child,
          message,
          retries: ProviderRetries.make(retries),
        }),
      }),
    );
  const lastAnsweredAt = DateTime.makeUnsafe(at(4));
  const worker = WorkerName.make("usine-worker-1");
  const unreachable =
    "Reconnecting... waiting for network (Connection failed: error sending request)";
  const events = [
    record(1, new AttemptChannel.Started({ parentModel: ModelId.make("gpt-5") })),
    ...delegation,
    said(3, "Running the gate."),
    retry(5, 1, "Reconnecting... 1/5 (request timed out)"),
    record(
      6,
      new AttemptChannel.WorkerUnresponsive({
        worker,
        lastAnsweredAt,
        reason: "No answer within 45 seconds",
      }),
    ),
    retry(7, 2, unreachable),
    retry(8, 3, unreachable),
  ];
  const notes = (rows: ReadonlyArray<ChapterRow>) =>
    rows.flatMap((row) => (row._tag === "Note" ? [`${row.tone}: ${row.text}`] : []));

  it("shows a silent Worker and a child's provider retries as warnings, each retry streak on one line", () => {
    const chapter = document(events, [attempt(null)]).chapters[0];
    assert(chapter !== undefined);
    assert.deepStrictEqual(notes(chapter.rows), [
      "warning: Provider unreachable, 1 retry so far. Reconnecting... 1/5 (request timed out)",
      `warning: usine-worker-1 silent since ${clockLabel(at(4))}. No answer within 45 seconds`,
      `warning: Provider unreachable, 3 retries so far. ${unreachable}`,
    ]);
    assert.deepStrictEqual(chapter.connectivity, [
      { _tag: "WorkerSilent", worker, lastAnsweredAt: at(4) },
      {
        _tag: "ProviderRetrying",
        sessionId: child.id,
        agent: child.agent,
        message: unreachable,
        retries: 3,
        since: at(5),
      },
    ]);
    assert(Option.contains(chapter.lastActivityAt, at(3)), "a report of no answer is not activity");
  });

  it("clears each warning when its Worker or provider answers again, and once the Attempt ends", () => {
    const answered = [
      ...events,
      record(
        9,
        new AttemptChannel.SessionEvent({
          event: new ProviderRecovered({ session: child, retries: ProviderRetries.make(3) }),
        }),
      ),
      record(10, new AttemptChannel.WorkerResponsive({ worker, lastAnsweredAt })),
    ];
    const chapter = document(answered, [attempt(null)]).chapters[0];
    assert(chapter !== undefined);
    assert.deepStrictEqual(chapter.connectivity, []);
    assert.deepStrictEqual(notes(chapter.rows).slice(-2), [
      "plain: Provider reachable again after 3 retries",
      "plain: usine-worker-1 answering again. Silent for 6s",
    ]);
    const failure = new InfraFailureView({ message: "Worker disconnected" });
    const ended = document(
      [...events, record(9, new FailedTranscriptView({ failure }))],
      [attempt(new FailedAttemptView({ failure }))],
    ).chapters[0];
    assert.deepStrictEqual(ended?.connectivity, []);
  });
});
