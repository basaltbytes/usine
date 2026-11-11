import type { ReactNode } from "react";
import { capabilitiesQuery } from "~/lib/configuration/capabilities";
import { capabilitiesFixture } from "~/lib/configuration/fixture";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow,
  SessionFinished,
  SessionStarted,
  HarnessSession,
  HarnessSessionId,
  ToolStarted,
  ToolFinished,
  TextOutput,
  type AgentSessionEvent,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentName } from "@usine/core/agent";
import {
  AttemptId,
  AttemptNumber,
  AttemptTask,
  ContainerOutOfMemoryKills,
  MemoryKilledProcess,
  OutOfMemoryKills,
  totalOutOfMemoryKills,
} from "@usine/core/attempt";
import { ContainerId, ContainerMemoryMib, WorkerName } from "@usine/core/worker";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepResult } from "@usine/core/step/result";
import { Option, type Schema } from "effect";
import { TranscriptSequence } from "@usine/engine/transcript";
import {
  AgentFailureView,
  AttemptView,
  BoardMovedView,
  CanceledAttemptView,
  ColdTranscriptRequest,
  CommentedView,
  LabelAddedView,
  LabelRemovedView,
  LabelView,
  FailedTranscriptView,
  RunDetailView,
  RunView,
  SucceededAttemptView,
  TailTranscriptRequest,
  TranscriptEventView,
  TranscriptPageCursor,
  LocalWorkerAccess,
} from "@usine/orchestrator/operator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { LaneName } from "@usine/config/board";
import { GitHubLabelName } from "@usine/config/label";
import { runDetailKey, runDetailKeys } from "~/lib/runs/queries";
import {
  mergeEarlierTranscript,
  mergeTranscript,
  poolMeters,
  replaceEarlierCursor,
  RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
} from "~/lib/runs/transcript/cache";
import { projectTranscript, type TranscriptTool } from "~/lib/runs/transcript/model";
import { Transcript } from "~/components/runs/transcript/transcript";
import { CurrentActivity } from "~/components/runs/transcript/activity";
import { readerDocument } from "~/lib/runs/transcript/document/model";
import { withGitHubChanges } from "~/lib/runs/transcript/document/github-changes";
import { TranscriptDisclosureProvider } from "~/components/runs/transcript/grouping/disclosure";
import { MessageScrollerProvider } from "~/components/ui/message-scroller";
import { presentTool, type ToolSection } from "~/lib/runs/transcript/tool/presentation";
import { fetchRunDetail } from "~/lib/runs/transcript/fetch";

const renderMarkup = (element: ReactNode): string => {
  const client = new QueryClient();
  client.setQueryData(capabilitiesQuery().queryKey, capabilitiesFixture());
  return renderToStaticMarkup(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
};

const attemptId = AttemptId.make("attempt-31");
const brain = BrainSpec.make({
  harness: Harness.make("codex"),
  model: ModelId.make("gpt-5"),
  effort: "high",
});

const liveAttempt = AttemptView.make({
  task: AttemptTask.make("Review the task"),
  agent: AgentName.make("developer"),
  operatorIntervened: false,
  id: attemptId,
  number: AttemptNumber.make(1),
  worker: WorkerName.make("local"),
  workerAccess: LocalWorkerAccess.make(),
  brain,
  startedAt: "2026-09-01T12:00:00.000Z",
  outcome: null,
  endedAt: null,
  salvage: null,
});
const parent = ParentSession.make({
  id: AgentSessionId.make("parent-session"),
  agent: AgentName.make("developer"),
  brain,
});
const child = ChildSession.make({
  id: AgentSessionId.make("child-session"),
  parentId: parent.id,
  agent: AgentName.make("reviewer"),
  brain,
});

const record = (sequence: number, payload: TranscriptEventView["payload"], attempt = attemptId) =>
  TranscriptEventView.make({
    sequence: TranscriptSequence.make(sequence),
    attemptId: attempt,
    receivedAt: new Date(Date.parse(liveAttempt.startedAt) + sequence * 1000).toISOString(),
    direction: "outbound",
    payload,
  });

const sessionEvent = (sequence: number, event: AgentSessionEvent, attempt = attemptId) =>
  record(sequence, AttemptChannel.SessionEvent.make({ event }), attempt);

const tools = (
  events: ReadonlyArray<TranscriptEventView>,
  attempts = [liveAttempt],
): ReadonlyArray<TranscriptTool> =>
  projectTranscript(events, attempts).sessions.flatMap(({ entries }) =>
    entries.filter((entry) => entry._tag === "Tool"),
  );

const event = (
  sequence: number,
  text: string,
  scope: "parent" | "child" | "channel" = "parent",
  session = `${scope}-session`,
) => {
  const agent = AgentName.make(scope === "child" ? `agent-${session}` : "developer");
  const sessionView =
    scope === "child"
      ? ChildSession.make({
          id: AgentSessionId.make(session),
          parentId: AgentSessionId.make("parent-session"),
          agent,
          brain,
        })
      : ParentSession.make({
          id: AgentSessionId.make(session),
          agent,
          brain,
        });
  return TranscriptEventView.make({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    receivedAt: "2026-09-01T12:00:00.000Z",
    direction: "outbound",
    payload:
      scope === "channel"
        ? AttemptChannel.Started.make({
            parentModel: Option.some(ModelId.make("gpt-5")),
          })
        : AttemptChannel.SessionEvent.make({
            event: TextOutput.make({ session: sessionView, text }),
          }),
  });
};

const rateLimits = (sequence: number, usedPercent: number) =>
  TranscriptEventView.make({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    receivedAt: "2026-09-01T12:00:00.000Z",
    direction: "outbound",
    payload: AttemptChannel.SessionEvent.make({
      event: PoolRateLimitsUpdated.make({
        session: ParentSession.make({
          id: AgentSessionId.make("parent-session"),
          agent: AgentName.make("developer"),
          brain,
        }),
        pool: "chatgptPlan",
        rateLimits: RateLimitsSnapshot.make({
          limitId: Option.none(),
          limitName: Option.none(),
          primary: Option.some(
            RateLimitWindow.make({
              usedPercent,
              windowDurationMinutes: Option.none(),
              resetsAt: Option.none(),
            }),
          ),
          secondary: Option.none(),
        }),
      }),
    }),
  });

const history = { cursors: [], loading: false, error: null, load: () => {} };

/** Renders the reader for `events`, with the bursts that contain the `open` tool calls expanded. */
const reader = (
  events: ReadonlyArray<TranscriptEventView>,
  attempts: ReadonlyArray<AttemptView> = [liveAttempt],
  open: ReadonlyArray<string> = [],
) =>
  renderMarkup(
    <TranscriptDisclosureProvider
      initialState={new Map(open.map((key) => [key, { open: false, groupOpen: true }]))}
    >
      <MessageScrollerProvider>
        <Transcript
          document={readerDocument(projectTranscript(events, attempts), attempts, events)}
          runTask="Review the task"
          history={history}
        />
      </MessageScrollerProvider>
    </TranscriptDisclosureProvider>,
  );

describe("run transcript", () => {
  it("keeps rate-limit updates out of the feed and shows one reading per pool with its Attempt", () => {
    const events = [event(1, "Parent update"), rateLimits(2, 25), rateLimits(3, 31)];
    const markup = reader(events);
    assert.ok(!markup.includes("rate limits"));
    assert.include(markup, "ChatGPT plan");
    assert.include(markup, "31% used");
    assert.notInclude(markup, "25%");
    assert.deepStrictEqual(
      poolMeters(events).map(({ pool, windows }) => ({
        pool,
        used: windows.map(({ usedPercent }) => usedPercent),
      })),
      [{ pool: "chatgptPlan", used: [31] }],
    );
  });

  it("shows an Agent's GitHub change as one line, labels in their GitHub colors and the comment linked, and the operator's Board move as theirs", () => {
    const events = [event(1, "Removing the claim and handing over for review.")];
    const label = (name: string, color: string) =>
      LabelView.make({ name: GitHubLabelName.make(name), color, description: null });
    const comment = "https://github.com/basaltbytes/usine/issues/247#issuecomment-6216970836";
    const document = withGitHubChanges(
      readerDocument(projectTranscript(events, [liveAttempt]), [liveAttempt], events),
      new Map([
        [
          attemptId,
          [
            LabelRemovedView.make({
              at: "2026-09-01T12:00:02.000Z",
              label: label("agent-in-progress", "fbca04"),
            }),
            LabelAddedView.make({
              at: "2026-09-01T12:00:02.000Z",
              label: label("ready-for-review", "0e8a16"),
            }),
            BoardMovedView.make({
              at: "2026-09-01T12:00:04.250Z",
              fromLane: LaneName.make("Review"),
              toLane: LaneName.make("Findings"),
            }),
            CommentedView.make({ at: "2026-09-01T12:00:07.000Z", url: comment }),
          ],
        ],
      ]),
      new Set(),
    );
    const markup = renderMarkup(
      <TranscriptDisclosureProvider initialState={new Map()}>
        <MessageScrollerProvider>
          <Transcript document={document} runTask="Review the task" history={history} />
        </MessageScrollerProvider>
      </TranscriptDisclosureProvider>,
    );
    const text = markup.replace(/<[^>]+>/gu, "");
    assert.include(text, "Removed agent-in-progress, added ready-for-review");
    assert.include(text, "You moved it from Review to Findings on the board");
    assert.include(text, "Commented on #247");
    assert.include(markup, "border-color:#fbca0466");
    assert.include(markup, "border-color:#0e8a1666");
    assert.include(markup, `href="${comment}"`);
  });

  it("separates an attempt's total out-of-memory kills from its last recorded container's limit", () => {
    const ended = (outOfMemory: OutOfMemoryKills | null) =>
      reader(
        [event(1, "Running the test gate.")],
        [AttemptView.make({ ...liveAttempt, outcome: CanceledAttemptView.make(), outOfMemory })],
      ).replace(/<[^>]+>/gu, "");
    const total = totalOutOfMemoryKills([
      ContainerOutOfMemoryKills.make({
        container: ContainerId.make("a".repeat(64)),
        kills: 2,
        memoryMib: ContainerMemoryMib.make(4096),
        processes: [MemoryKilledProcess.make({ command: "vitest worker", pid: 1234 })],
      }),
      ContainerOutOfMemoryKills.make({
        container: ContainerId.make("b".repeat(64)),
        kills: 1,
        memoryMib: ContainerMemoryMib.make(7168),
      }),
    ]);
    assert.include(
      ended(total),
      "Warning: The kernel killed 3 processes for memory across containers in this attempt. The last container with recorded kills had a 7168 MiB memory limit",
    );
    assert.include(
      ended(OutOfMemoryKills.make({ kills: 1, memoryMib: ContainerMemoryMib.make(4096) })),
      "Warning: The kernel killed 1 process for memory across containers in this attempt. The last container with recorded kills had a 4096 MiB memory limit",
    );
    assert.include(ended(total), "vitest worker (host PID 1234)");
    assert.include(ended(total), "Process details unavailable for 2 kills.");
    assert.notInclude(ended(null), "The kernel killed");
  });

  it("keeps a finished child's handoff when its launch is outside the loaded page", () => {
    const saved = HarnessSession.make({
      id: HarnessSessionId.make("vendor-thread"),
      cwd: "/worker/repo",
    });
    const started = sessionEvent(
      1,
      SessionStarted.make({
        session: child,
        harnessSession: Option.some(saved),
        prompt: Option.some("Exact child prompt\n  unchanged"),
      }),
    );
    const finished = sessionEvent(2, SessionFinished.make({ session: child }));
    const projection = projectTranscript([finished], [liveAttempt], [started, finished]);
    const session = projection.sessions[0];
    assert(session !== undefined);
    assert.strictEqual(session.status, "Finished");
    assert.deepStrictEqual(session.harnessSession, Option.some(saved));
    assert.deepStrictEqual(session.prompt, Option.some("Exact child prompt\n  unchanged"));
    assert.strictEqual(session.entries.length, 1);
    const legacy = projectTranscript(
      [sessionEvent(1, SessionStarted.make({ session: child }))],
      [liveAttempt],
    );
    const legacySession = legacy.sessions[0];
    assert(legacySession !== undefined);
    assert(Option.isNone(legacySession.harnessSession));
    assert(Option.isNone(legacySession.prompt));
  });

  it("reads parent and child messages inline in order, naming each speaker once per turn", () => {
    const markup = reader(
      [
        event(1, "**Parent update**"),
        event(2, "Child update", "child"),
        event(3, "Another child update", "child"),
        event(4, "Channel notice", "channel"),
      ],
      [AttemptView.make({ ...liveAttempt, outcome: SucceededAttemptView.make() })],
    );
    assert.include(markup, "<strong>Parent update</strong>");
    assert.ok(markup.indexOf("Parent update") < markup.indexOf("Child update"));
    assert.ok(markup.indexOf("Child update") < markup.indexOf("Another child update"));
    assert.lengthOf(markup.match(/>agent-child-session</gu) ?? [], 1);
    assert.notInclude(markup, "Attempt started");
    assert.include(markup, "gpt-5");
  });

  it("keeps concurrent child sessions distinct, each named where its turn starts", () => {
    const markup = reader([
      event(1, "First child says hello", "child", "child-a"),
      event(2, "Parent update"),
      event(3, "Second child says hello", "child", "child-b"),
    ]);
    const order = [
      ">agent-child-a<",
      "First child says hello",
      ">Parent<",
      "Parent update",
      ">agent-child-b<",
      "Second child says hello",
    ].map((text) => markup.indexOf(text));
    assert.notInclude(order, -1);
    assert.deepEqual(
      order,
      [...order].sort((left, right) => left - right),
    );
  });

  it("updates a tool call in place while retaining full input, output, and elapsed time", () => {
    const input = { command: "pnpm test", description: "Run the suite", context: "x".repeat(200) };
    const output = { text: "All tests passed", details: "y".repeat(200) };
    const started = sessionEvent(
      1,
      ToolStarted.make({ session: parent, callId: "call-1", tool: "shell", input }),
    );
    const finished = sessionEvent(
      3,
      ToolFinished.make({
        session: parent,
        callId: "call-1",
        tool: "shell",
        output,
        isError: false,
      }),
    );
    const running = tools([started]);
    const completed = tools([started, finished]);
    assert.strictEqual(running.length, 1);
    assert.strictEqual(completed.length, 1);
    assert.strictEqual(completed[0]?.key, running[0]?.key);
    assert.strictEqual(running[0]?.state._tag, "Running");
    const call = completed[0];
    assert(call !== undefined && call.state._tag === "Finished");
    assert.deepStrictEqual(
      Option.map(call.start, ({ input }) => input),
      Option.some(input),
    );
    assert.deepStrictEqual(call.state.output, output);
    const markup = reader([started, finished], [liveAttempt], [call.key]);
    assert.include(markup, "Command: pnpm test · Completed");
    assert.include(markup, "pnpm test");
    assert.notInclude(markup, "Run the suite");
    assert.include(markup, "2.0s");
  });

  it("shows a tool result whose earlier start has not been loaded", () => {
    const output = { message: "Permission denied" };
    const finished = sessionEvent(
      3,
      ToolFinished.make({ session: parent, callId: "call-1", tool: "read", output, isError: true }),
    );
    const call = tools([finished])[0];
    assert(call !== undefined && call.state._tag === "Error");
    assert.deepStrictEqual(call.start, Option.none());
    assert.deepStrictEqual(call.state.output, output);
    const markup = reader([finished], [liveAttempt], [call.key]);
    assert.include(markup, "Read file: File details unavailable · Error");
  });

  it("scopes repeated session and tool identities to their own Attempt", () => {
    const retried = AttemptView.make({
      ...liveAttempt,
      id: AttemptId.make("attempt-32"),
      number: AttemptNumber.make(2),
    });
    const failed = AttemptView.make({ ...liveAttempt, outcome: CanceledAttemptView.make() });
    const start = ToolStarted.make({
      session: child,
      callId: "same-call",
      tool: "read",
      input: { path: "README.md" },
    });
    const events = [sessionEvent(1, start), sessionEvent(2, start, retried.id)];
    const projection = projectTranscript(events, [failed, retried]);
    assert.strictEqual(projection.sessions.length, 2);
    assert.notEqual(projection.sessions[0]?.key, projection.sessions[1]?.key);
    const calls = tools(events, [failed, retried]);
    assert.strictEqual(calls.length, 2);
    assert.notEqual(calls[0]?.key, calls[1]?.key);
    assert.deepStrictEqual(
      calls.map(({ state }) => state._tag),
      ["Stopped", "Running"],
    );
    const document = readerDocument(projection, [failed, retried], events);
    assert.deepStrictEqual(
      document.chapters.map(({ live }) => live),
      [false, true],
    );
    const second = document.chapters[1];
    assert(second !== undefined);
    const activity = renderMarkup(<CurrentActivity chapter={second} />);
    assert.include(activity, "reviewer");
    assert.include(activity, "Reading file");
    assert.include(activity, "README.md");
    assert.notInclude(activity, "Stopped");
  });

  it.each([
    AttemptChannel.Final.make({ result: StepResult.make({ message: "Done", facts: [] }) }),
    FailedTranscriptView.make({ failure: AgentFailureView.make({ message: "Failed" }) }),
    AttemptChannel.Interrupted.make(),
  ])(
    "stops unfinished session activity when $_tag reaches the transcript before Run metadata",
    (terminal) => {
      const events = [
        sessionEvent(
          1,
          ToolStarted.make({
            session: child,
            callId: "call-1",
            tool: "shell",
            input: { command: "pnpm test" },
          }),
        ),
        record(2, terminal),
      ];
      const projection = projectTranscript(events, [liveAttempt]);
      assert.strictEqual(projection.sessions[0]?.status, "Stopped");
      assert.strictEqual(tools(events)[0]?.state._tag, "Stopped");
      assert.isFalse(readerDocument(projection, [liveAttempt], events).chapters[0]?.live);
      const markup = reader(events);
      assert.notInclude(markup, "Current activity");
      assert.notInclude(markup, "running");
    },
  );

  it("reports an explicitly finished child without inferring success and closes unfinished tools", () => {
    const events = [
      sessionEvent(
        1,
        ToolStarted.make({ session: child, callId: "call-1", tool: "read", input: null }),
      ),
      sessionEvent(2, SessionFinished.make({ session: child })),
    ];
    const projection = projectTranscript(events, [liveAttempt]);
    assert.strictEqual(projection.sessions[0]?.status, "Finished");
    assert.strictEqual(tools(events)[0]?.state._tag, "Stopped");
    const markup = reader(events);
    assert.notInclude(markup, "Succeeded");
    assert.notInclude(markup.replace(/<[^>]+>/gu, ""), "running");
  });

  it("says an Attempt without a parent session has none in its metadata line", () => {
    const events = [
      record(1, AttemptChannel.Started.make({})),
      sessionEvent(2, TextOutput.make({ session: child, text: "Child explanation" })),
    ];
    const document = readerDocument(
      projectTranscript(events, [liveAttempt]),
      [liveAttempt],
      events,
    );
    assert.deepStrictEqual(document.chapters[0]?.parent, { _tag: "NoSession" });
    const markup = reader(events);
    assert.include(markup, "No parent session");
    assert.include(markup, "Child reviewer on Codex,");
    assert.include(markup, "Child explanation");
    assert.notInclude(markup, "Parent on");
    assert.notInclude(markup, "Parent model");
  });

  it("reports the parent model of a started Attempt and none before it starts", () => {
    const started = [
      record(1, AttemptChannel.Started.make({ parentModel: Option.some(brain.model) })),
    ];
    const unstarted = [
      sessionEvent(1, TextOutput.make({ session: child, text: "Child explanation" })),
    ];
    const parentOf = (events: ReadonlyArray<TranscriptEventView>) =>
      readerDocument(projectTranscript(events, [liveAttempt]), [liveAttempt], events).chapters[0]
        ?.parent;
    assert.deepStrictEqual(parentOf(started), { _tag: "Model", model: brain.model });
    assert.deepStrictEqual(parentOf(unstarted), { _tag: "Unreported" });
    assert.notInclude(reader(unstarted), "No parent session");
  });

  it("names the Attempt's models in its metadata line instead of a start row, and keeps every session's prose", () => {
    const events = [
      record(1, AttemptChannel.Started.make({ parentModel: Option.some(brain.model) })),
      sessionEvent(2, TextOutput.make({ session: parent, text: "A useful explanation" })),
      sessionEvent(
        3,
        ToolStarted.make({
          session: parent,
          callId: "call-1",
          tool: "read",
          input: { path: "README.md" },
        }),
      ),
      sessionEvent(4, TextOutput.make({ session: child, text: "Child explanation" })),
    ];
    const markup = reader(events);
    assert.include(markup, "A useful explanation");
    assert.include(markup, "Child explanation");
    assert.include(markup, "Parent on Codex,");
    assert.include(markup, "Child reviewer on Codex,");
    assert.include(markup, brain.model);
    assert.notInclude(markup, "Attempt started");
    assert.match(
      markup,
      /Read README\.md<span[^>]*>, <svg data-slot="usine-mark" data-running=""[^>]*>.*?<\/svg>1(?:<!-- -->)? running/u,
    );
  });

  it("merges transcript tails by sequence without replaying an existing event", () => {
    const first = event(1, "First");
    const second = event(2, "Second");
    const merged = mergeTranscript([second, first], [second, event(3, "Third")]);

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
    const firstAttempt = AttemptId.make("attempt-1");
    const secondAttempt = AttemptId.make("attempt-2");
    const cursors = [
      TranscriptPageCursor.make({
        attemptId: firstAttempt,
        before: TranscriptSequence.make(100),
      }),
      TranscriptPageCursor.make({
        attemptId: secondAttempt,
        before: TranscriptSequence.make(200),
      }),
    ];
    const replaced = replaceEarlierCursor(cursors, secondAttempt, [
      TranscriptPageCursor.make({
        attemptId: secondAttempt,
        before: TranscriptSequence.make(50),
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

  it("advances manual earlier-page cursors through the TanStack cache until exhaustion", () => {
    const queryClient = new QueryClient();
    const key = runDetailKey(RunId.make("run-31"));
    queryClient.setQueryDefaults(runDetailKeys, {
      structuralSharing: RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
    });
    queryClient.setQueryData(key, {
      earlierTranscript: [
        TranscriptPageCursor.make({
          attemptId,
          before: TranscriptSequence.make(300),
        }),
      ],
    });

    for (const before of [200, 100] as const) {
      queryClient.setQueryData<{ earlierTranscript: ReadonlyArray<TranscriptPageCursor> }>(
        key,
        (previous) => ({
          earlierTranscript: replaceEarlierCursor(previous?.earlierTranscript ?? [], attemptId, [
            TranscriptPageCursor.make({
              attemptId,
              before: TranscriptSequence.make(before),
            }),
          ]),
        }),
      );
      const current = queryClient.getQueryData<{
        earlierTranscript: ReadonlyArray<TranscriptPageCursor>;
      }>(key)?.earlierTranscript[0]?.before;
      assert(current !== undefined);
      assert.strictEqual(current, TranscriptSequence.make(before));
    }

    queryClient.setQueryData<{ earlierTranscript: ReadonlyArray<TranscriptPageCursor> }>(
      key,
      (previous) => ({
        earlierTranscript: replaceEarlierCursor(previous?.earlierTranscript ?? [], attemptId, []),
      }),
    );
    assert.deepStrictEqual(
      queryClient.getQueryData<{ earlierTranscript: ReadonlyArray<TranscriptPageCursor> }>(key)
        ?.earlierTranscript,
      [],
    );
  });

  it("adds an earlier page without replacing a newer Run outcome or available actions", () => {
    const cursor = TranscriptPageCursor.make({ attemptId, before: TranscriptSequence.make(2) });
    const stale = RunDetailView.make({
      agentDefinitionChanged: false,
      sessionState: [],
      run: RunView.make({
        agentBrain: brain,
        id: RunId.make("run-31"),
        itemKey: ItemKey.make("github:basaltbytes/usine:31"),
        loop: LoopName.make("develop"),
        repository: RepositoryName.make("basaltbytes/usine"),
        agent: parent.agent,
        state: "Running",
        loopPaused: false,
        openedAt: liveAttempt.startedAt,
        closedAt: null,
        task: "Build it",
        attempts: [liveAttempt],
        approval: null,
        runAgain: null,
        resultMessage: null,
        pullRequestUrl: null,
        canApprove: false,
        canRetry: false,
        canResolveFailure: false,
        canCancel: true,
        canRunAgain: false,
      }),
      eventDedupKey: "issue:31",
      eventPayload: { number: 31 },
      transcript: [event(1, "Earlier message")],
      earlierTranscript: [],
    });
    const current = RunDetailView.make({
      ...stale,
      run: RunView.make({
        ...stale.run,
        state: "Succeeded",
        attempts: [AttemptView.make({ ...liveAttempt, outcome: SucceededAttemptView.make() })],
        approval: null,
        resultMessage: "Delivered",
        canCancel: false,
      }),
      transcript: [event(2, "Latest message")],
      earlierTranscript: [cursor],
    });
    const merged = mergeEarlierTranscript(current, stale, cursor);
    assert.deepStrictEqual(merged.run, current.run);
    assert.deepStrictEqual(merged.transcript, [...stale.transcript, ...current.transcript]);
    assert.deepStrictEqual(merged.earlierTranscript, []);
  });

  it("drains a completed Run's capped tail through its final event before polling stops", async () => {
    const transcript = [
      event(11, "First page"),
      event(12, "Second page"),
      record(
        13,
        AttemptChannel.Final.make({
          result: StepResult.make({ message: "All work complete", facts: [] }),
        }),
      ),
    ];
    const detail = RunDetailView.make({
      agentDefinitionChanged: false,
      sessionState: [],
      run: RunView.make({
        agentBrain: brain,
        id: RunId.make("run-31"),
        itemKey: ItemKey.make("github:basaltbytes/usine:31"),
        loop: LoopName.make("develop"),
        repository: RepositoryName.make("basaltbytes/usine"),
        agent: parent.agent,
        state: "Succeeded",
        loopPaused: false,
        openedAt: liveAttempt.startedAt,
        closedAt: liveAttempt.startedAt,
        task: "Build it",
        attempts: [AttemptView.make({ ...liveAttempt, outcome: SucceededAttemptView.make() })],
        approval: null,
        runAgain: null,
        resultMessage: "All work complete",
        pullRequestUrl: null,
        canApprove: false,
        canRetry: false,
        canResolveFailure: false,
        canCancel: false,
        canRunAgain: false,
      }),
      eventDedupKey: "issue:31",
      eventPayload: { number: 31 },
      transcript: [],
      earlierTranscript: [],
    });
    // This fake API pages smaller than production, so the reader must follow cursors instead of
    // assuming a page size.
    const read = async (request: ColdTranscriptRequest | TailTranscriptRequest) => {
      const after = request._tag === "TailTranscriptRequest" ? request.after : 0;
      return RunDetailView.make({
        ...detail,
        transcript: transcript.filter(({ sequence }) => sequence > after).slice(0, 1),
      });
    };
    const loaded = await fetchRunDetail(
      TailTranscriptRequest.make({ after: TranscriptSequence.make(10) }),
      read,
    );
    assert.deepStrictEqual(loaded.transcript, transcript);
    assert.strictEqual(loaded.run.resultMessage, "All work complete");

    const running = RunDetailView.make({
      ...detail,
      run: RunView.make({
        ...detail.run,
        state: "Running",
        attempts: [liveAttempt],
        approval: null,
        resultMessage: null,
        canCancel: true,
      }),
    });
    const onePoll = await fetchRunDetail(
      TailTranscriptRequest.make({ after: TranscriptSequence.make(10) }),
      async (request) =>
        RunDetailView.make({
          ...running,
          transcript: (await read(request)).transcript,
        }),
    );
    assert.deepStrictEqual(onePoll.transcript, transcript.slice(0, 1));
    assert.strictEqual(onePoll.run.canCancel, true);

    const cold = RunDetailView.make({
      ...detail,
      transcript: transcript.slice(-1),
      earlierTranscript: [
        TranscriptPageCursor.make({ attemptId, before: TranscriptSequence.make(13) }),
      ],
    });
    const initial = await fetchRunDetail(ColdTranscriptRequest.make(), async (request) =>
      request._tag === "ColdTranscriptRequest" ? cold : read(request),
    );
    assert.deepStrictEqual(initial, cold);
  });
});

const completedTool = (name: string, input: Schema.Json, output: Schema.Json) => {
  const call = tools([
    sessionEvent(1, ToolStarted.make({ session: parent, callId: "presented", tool: name, input })),
    sessionEvent(
      2,
      ToolFinished.make({
        session: parent,
        callId: "presented",
        tool: name,
        output,
        isError: false,
      }),
    ),
  ])[0];
  assert(call !== undefined);
  return call;
};

const sectionText = (sections: ReadonlyArray<ToolSection>): string =>
  sections.flatMap((section) => (section._tag === "Fields" ? [] : [section.text])).join("\n");

const sectionFields = (sections: ReadonlyArray<ToolSection>) =>
  sections.flatMap((section) => (section._tag === "Fields" ? section.fields : []));

describe("tool presentation", () => {
  it("shows a Codex command and its actual output with exit status instead of protocol envelopes", () => {
    const input = {
      type: "commandExecution",
      id: "cmd-1",
      command: "pnpm test\npnpm check",
      cwd: "/workspace/repo",
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const output = {
      ...input,
      status: "completed",
      aggregatedOutput: "3 tests passed\nTypes checked\n",
      exitCode: 0,
      durationMs: 1250,
    };
    const call = completedTool("command", input, output);
    const view = presentTool(call);

    assert.strictEqual(view.subject, "pnpm test\npnpm check");
    assert.include(sectionText(view.input), "pnpm test\npnpm check");
    assert.include(sectionText(view.output), "3 tests passed\nTypes checked\n");
    assert.deepInclude(sectionFields(view.input), {
      label: "Working directory",
      value: "/workspace/repo",
    });
    assert.deepInclude(sectionFields(view.output), { label: "Exit code", value: 0 });
    assert.deepInclude(sectionFields(view.output), { label: "Duration (ms)", value: 1250 });
    assert(call.state._tag === "Finished");
    assert.deepStrictEqual(call.state.output, output);
  });

  it("unwraps Pi text blocks and Claude content without losing line breaks or error text", () => {
    const command = "pnpm test";
    const output = "Test failed\nExpected 2, received 1\nCommand exited with code 1";
    for (const result of [
      { content: [{ type: "text", text: output }] },
      [{ type: "text", text: output }],
      output,
    ]) {
      const view = presentTool(completedTool("Bash", { command }, result));
      assert.strictEqual(view.subject, command);
      assert.strictEqual(sectionText(view.output), output);
    }
  });

  it("shows Pi's returned unified patch once, retaining file metadata", () => {
    const patch =
      "--- src/count.ts\n+++ src/count.ts\n@@ -1,1 +1,1 @@\n-export const count = 1;\n+export const count = 2;\n";
    const view = presentTool(
      completedTool(
        "edit",
        {
          path: "src/count.ts",
          edits: [{ oldText: "count = 1", newText: "count = 2" }],
        },
        {
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/count.ts." }],
          details: {
            diff: "-1 export const count = 1;\n+1 export const count = 2;",
            patch,
            firstChangedLine: 1,
          },
        },
      ),
    );

    assert.strictEqual(view.subject, "src/count.ts");
    assert.strictEqual(sectionText(view.input), "");
    assert.include(sectionText(view.output), patch);
    assert.deepInclude(sectionFields(view.output), { label: "First changed line", value: 1 });
  });

  it("shows every Codex changed file with its real diff, including changes whose start is unpaged", () => {
    const changes = [
      { path: "src/new.ts", kind: { type: "add" }, diff: "+export const ready = true;\n" },
      { path: "src/old.ts", kind: { type: "delete" }, diff: "-export const old = true;\n" },
    ];
    const call = tools([
      sessionEvent(
        2,
        ToolFinished.make({
          session: parent,
          callId: "changes",
          tool: "file_change",
          isError: false,
          output: { type: "fileChange", id: "changes", status: "completed", changes },
        }),
      ),
    ])[0];
    assert(call !== undefined);
    const view = presentTool(call);

    assert.strictEqual(view.subject, "2 files");
    assert.deepStrictEqual(
      view.output.map(({ label }) => label),
      ["src/new.ts · add", "src/old.ts · delete"],
    );
    assert.include(sectionText(view.output), "+export const ready = true;\n");
    assert.include(sectionText(view.output), "-export const old = true;\n");
  });

  it("keeps a proposed file change separate from a result that has not arrived", () => {
    const call = tools([
      sessionEvent(
        1,
        ToolStarted.make({
          session: parent,
          callId: "pending-edit",
          tool: "file_change",
          input: {
            type: "fileChange",
            id: "pending-edit",
            status: "inProgress",
            changes: [
              { path: "src/new.ts", kind: { type: "add" }, diff: "+export const ready = true;\n" },
            ],
          },
        }),
      ),
    ])[0];
    assert(call !== undefined);
    const view = presentTool(call);
    assert.strictEqual(view.subject, "src/new.ts");
    assert.include(sectionText(view.input), "+export const ready = true;\n");
    assert.deepStrictEqual(view.output, []);
  });

  it("presents Claude read, edit, write and search fields by their operator meaning", () => {
    const read = presentTool(
      completedTool(
        "Read",
        { file_path: "/repo/src/count.ts", offset: 12, limit: 3 },
        "12→export const count = 1;",
      ),
    );
    assert.strictEqual(read.subject, "/repo/src/count.ts · From line 12 · up to 3 lines");
    assert.include(sectionText(read.output), "12→export const count = 1;");
    assert.include(
      read.output.map(({ label }) => label),
      "/repo/src/count.ts",
    );

    const edit = presentTool(
      completedTool(
        "Edit",
        {
          file_path: "/repo/src/count.ts",
          old_string: "count = 1",
          new_string: "count = 2",
          replace_all: false,
        },
        "The file has been updated.",
      ),
    );
    assert.include(sectionText(edit.input), "count = 1\ncount = 2");
    const write = presentTool(
      completedTool(
        "Write",
        { file_path: "/repo/src/new.ts", content: "export const ready = true;\n" },
        "File created successfully.",
      ),
    );
    assert.strictEqual(write.subject, "/repo/src/new.ts");
    assert.strictEqual(sectionText(write.input), "export const ready = true;\n");
    const search = presentTool(
      completedTool(
        "Grep",
        { pattern: "RunReader", path: "packages", glob: "*.ts" },
        "packages/engine/src/run-reader.ts",
      ),
    );
    assert.strictEqual(search.subject, "RunReader");
    assert.deepInclude(sectionFields(search.input), { label: "Path", value: "packages" });
    assert.include(sectionText(search.output), "packages/engine/src/run-reader.ts");
  });

  it("presents delegation as a task and readable child report", () => {
    const view = presentTool(
      completedTool(
        "subagent",
        { task: "Review the retry behavior.\nReport any stalls." },
        {
          content: [{ type: "text", text: "Retry is bounded.\nNo stalls found." }],
          details: { childSessionId: "parent:child:1" },
        },
      ),
    );
    assert.include(view.subject, "Review the retry behavior.");
    assert.strictEqual(sectionText(view.input), "Review the retry behavior.\nReport any stalls.");
    assert.strictEqual(sectionText(view.output), "Retry is bounded.\nNo stalls found.");
    assert.deepInclude(sectionFields(view.output), {
      label: "Details",
      value: { childSessionId: "parent:child:1" },
    });
  });

  it("unwraps Codex MCP and dynamic results while preserving structured result data and errors", () => {
    const input = {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "github",
      tool: "get_issue",
      arguments: { number: 79 },
      status: "inProgress",
    };
    const output = {
      ...input,
      status: "completed",
      result: {
        content: [{ type: "text", text: "Conversation UX" }],
        structuredContent: { number: 79, state: "open" },
        _meta: null,
      },
      error: null,
    };
    const mcp = presentTool(completedTool("mcp_tool", input, output));
    assert.strictEqual(mcp.title, "github · get_issue");
    assert.deepInclude(sectionFields(mcp.input), { label: "Number", value: 79 });
    assert.strictEqual(sectionText(mcp.output), "Conversation UX");
    assert.deepInclude(sectionFields(mcp.output), {
      label: "Structured content",
      value: { number: 79, state: "open" },
    });

    const dynamic = presentTool(
      completedTool(
        "dynamic_tool",
        { type: "dynamicToolCall", tool: "validate", arguments: {} },
        {
          type: "dynamicToolCall",
          contentItems: [{ type: "inputText", text: "Validation failed" }],
          success: false,
        },
      ),
    );
    assert.strictEqual(dynamic.title, "validate");
    assert.strictEqual(sectionText(dynamic.output), "Validation failed");
    const failed = presentTool(
      completedTool("mcp_tool", input, {
        ...input,
        result: null,
        error: { message: "Permission denied" },
      }),
    );
    assert.include(sectionText(failed.output), "Permission denied");
  });

  it("keeps unfamiliar tool parameters readable and leaves opaque result content available", () => {
    const input = { destination: "staging", retries: 0, settings: { region: "eu" } };
    const output = { receipt: { id: "deploy-12", artifacts: ["app.js"] }, cached: false };
    const call = completedTool("publish_preview", input, output);
    const view = presentTool(call);
    assert.strictEqual(view.title, "publish_preview");
    assert.strictEqual(view.subject, "3 parameters");
    assert.deepInclude(sectionFields(view.input), { label: "Retries", value: 0 });
    assert.deepInclude(sectionFields(view.input), { label: "Settings", value: { region: "eu" } });
    assert.deepInclude(sectionFields(view.output), { label: "Receipt", value: output.receipt });
    assert.deepInclude(sectionFields(view.output), { label: "Cached", value: false });
    assert.deepStrictEqual(
      Option.map(call.start, ({ input }) => input),
      Option.some(input),
    );
  });
});
