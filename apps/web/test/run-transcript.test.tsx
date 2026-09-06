import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow,
  SessionFinished,
  ToolStarted,
  ToolFinished,
  TextOutput,
  type AgentSessionEvent,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentName } from "@usine/core/agent";
import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import { WorkerName } from "@usine/core/worker";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepResult } from "@usine/core/step/result";
import { Option } from "effect";
import { TranscriptSequence } from "@usine/engine/transcript";
import {
  AgentFailureView,
  AttemptView,
  CanceledAttemptView,
  FailedTranscriptView,
  RunDetailView,
  RunView,
  SucceededAttemptView,
  TranscriptEventView,
  TranscriptPageCursor,
} from "@usine/orchestrator/operator";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import {
  mergeEarlierTranscript,
  mergeTranscript,
  poolMeters,
  replaceEarlierCursor,
  RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
} from "../src/run-transcript/cache.ts";
import { projectTranscript, type TranscriptTool } from "../src/run-transcript/model.ts";
import { SessionActivity, Transcript } from "../src/run-transcript/transcript.tsx";

const attemptId = AttemptId.make("attempt-31");
const brain = new BrainSpec({
  harness: "codex",
  model: ModelId.make("gpt-5"),
  effort: "high",
});
const liveAttempt = new AttemptView({
  id: attemptId,
  number: AttemptNumber.make(1),
  worker: WorkerName.make("local"),
  brain,
  startedAt: "2026-09-01T12:00:00.000Z",
  outcome: null,
});
const parent = new ParentSession({
  id: AgentSessionId.make("parent-session"),
  agent: AgentName.make("developer"),
  brain,
});
const child = new ChildSession({
  id: AgentSessionId.make("child-session"),
  parentId: parent.id,
  agent: AgentName.make("reviewer"),
  brain,
});

const record = (sequence: number, payload: TranscriptEventView["payload"], attempt = attemptId) =>
  new TranscriptEventView({
    sequence: TranscriptSequence.make(sequence),
    attemptId: attempt,
    receivedAt: new Date(Date.parse(liveAttempt.startedAt) + sequence * 1000).toISOString(),
    direction: "outbound",
    payload,
  });

const sessionEvent = (sequence: number, event: AgentSessionEvent, attempt = attemptId) =>
  record(sequence, new AttemptChannel.SessionEvent({ event }), attempt);

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
      ? new ChildSession({
          id: AgentSessionId.make(session),
          parentId: AgentSessionId.make("parent-session"),
          agent,
          brain,
        })
      : new ParentSession({
          id: AgentSessionId.make(session),
          agent,
          brain,
        });
  return new TranscriptEventView({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    receivedAt: "2026-09-01T12:00:00.000Z",
    direction: "outbound",
    payload:
      scope === "channel"
        ? new AttemptChannel.Started({
            parentModel: ModelId.make("gpt-5"),
          })
        : new AttemptChannel.SessionEvent({
            event: new TextOutput({ session: sessionView, text }),
          }),
  });
};

const rateLimits = (sequence: number, usedPercent: number) =>
  new TranscriptEventView({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    receivedAt: "2026-09-01T12:00:00.000Z",
    direction: "outbound",
    payload: new AttemptChannel.SessionEvent({
      event: new PoolRateLimitsUpdated({
        session: new ParentSession({
          id: AgentSessionId.make("parent-session"),
          agent: AgentName.make("developer"),
          brain,
        }),
        pool: "chatgptPlan",
        rateLimits: new RateLimitsSnapshot({
          limitId: Option.none(),
          limitName: Option.none(),
          primary: Option.some(
            new RateLimitWindow({
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

describe("run transcript", () => {
  it("keeps rate-limit updates out of the feed and folds them into one meter per pool", () => {
    const events = [event(1, "Parent update"), rateLimits(2, 25), rateLimits(3, 31)];
    const markup = renderToStaticMarkup(
      <Transcript events={events} attempts={[liveAttempt]} filter="all" />,
    );
    assert.ok(!markup.includes("rate limits"));
    assert.deepStrictEqual(poolMeters(events), [
      { pool: "chatgptPlan", primaryUsedPercent: 31, secondaryUsedPercent: null },
    ]);
  });

  it("renders parent activity inline and groups each child session one level deep", () => {
    const events = [
      event(1, "**Parent update**"),
      event(2, "Child update", "child"),
      event(3, "Another child update", "child"),
      event(4, "Channel notice", "channel"),
    ];
    const markup = renderToStaticMarkup(
      <Transcript events={events} attempts={[liveAttempt]} filter="all" />,
    );
    assert.include(markup, "<strong>Parent update</strong>");
    assert.include(markup, "agent-child-session activity · Working");
    assert.ok(markup.indexOf("Parent update") < markup.indexOf("activity"));
    assert.ok(markup.indexOf("activity") < markup.indexOf("Attempt started"));
  });

  it("keeps concurrent child sessions distinct, each anchored at its own first event", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        attempts={[liveAttempt]}
        filter="all"
        events={[
          event(1, "First child says hello", "child", "child-a"),
          event(2, "Parent update"),
          event(3, "Second child says hello", "child", "child-b"),
        ]}
      />,
    );

    assert.include(markup, "agent-child-a activity · Working");
    assert.include(markup, "agent-child-b activity · Working");
    assert.ok(markup.indexOf("agent-child-a activity") < markup.indexOf("Parent update"));
    assert.ok(markup.indexOf("Parent update") < markup.indexOf("agent-child-b activity"));
  });

  it("updates a tool call in place while retaining full input, output, and elapsed time", () => {
    const input = { command: "pnpm test", description: "Run the suite", context: "x".repeat(200) };
    const output = { text: "All tests passed", details: "y".repeat(200) };
    const started = sessionEvent(
      1,
      new ToolStarted({ session: parent, callId: "call-1", tool: "shell", input }),
    );
    const finished = sessionEvent(
      3,
      new ToolFinished({
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
    const markup = renderToStaticMarkup(
      <Transcript events={[started, finished]} attempts={[liveAttempt]} filter="all" />,
    );
    assert.include(markup, "shell · Finished");
    assert.include(markup, "pnpm test");
    assert.notInclude(markup, "Run the suite");
    assert.include(markup, "2.0s");
  });

  it("shows a tool result whose earlier start has not been loaded", () => {
    const output = { message: "Permission denied" };
    const finished = sessionEvent(
      3,
      new ToolFinished({ session: parent, callId: "call-1", tool: "read", output, isError: true }),
    );
    const call = tools([finished])[0];
    assert(call !== undefined && call.state._tag === "Error");
    assert.deepStrictEqual(call.start, Option.none());
    assert.deepStrictEqual(call.state.output, output);
    const markup = renderToStaticMarkup(
      <Transcript events={[finished]} attempts={[liveAttempt]} filter="tools" />,
    );
    assert.include(markup, "read · Error");
    assert.include(markup, "Earlier input is not loaded");
  });

  it("scopes repeated session and tool identities to their own Attempt", () => {
    const retried = new AttemptView({
      ...liveAttempt,
      id: AttemptId.make("attempt-32"),
      number: AttemptNumber.make(2),
    });
    const failed = new AttemptView({ ...liveAttempt, outcome: new CanceledAttemptView() });
    const start = new ToolStarted({
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
    const summary = renderToStaticMarkup(
      <SessionActivity events={events} attempts={[failed, retried]} />,
    );
    assert.include(summary, "Attempt 2");
    assert.include(summary, "Awaiting parent activity");
    assert.include(summary, "1 live");
    assert.notInclude(summary, "stopped");
  });

  it.each([
    new AttemptChannel.Final({ result: new StepResult({ message: "Done", facts: [] }) }),
    new FailedTranscriptView({ failure: new AgentFailureView({ message: "Failed" }) }),
    new AttemptChannel.Interrupted(),
  ])(
    "stops unfinished session activity when $_tag reaches the transcript before Run metadata",
    (terminal) => {
      const events = [
        sessionEvent(
          1,
          new ToolStarted({
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
      const markup = renderToStaticMarkup(
        <Transcript events={events} attempts={[liveAttempt]} filter="all" />,
      );
      assert.include(markup, "reviewer activity · Stopped");
      const summary = renderToStaticMarkup(
        <SessionActivity events={[record(2, terminal)]} attempts={[liveAttempt]} />,
      );
      assert.include(summary, "Ended");
      assert.notInclude(summary, "Awaiting parent activity");
    },
  );

  it("reports an explicitly finished child without inferring success and closes unfinished tools", () => {
    const events = [
      sessionEvent(
        1,
        new ToolStarted({ session: child, callId: "call-1", tool: "read", input: null }),
      ),
      sessionEvent(2, new SessionFinished({ session: child })),
    ];
    const projection = projectTranscript(events, [liveAttempt]);
    assert.strictEqual(projection.sessions[0]?.status, "Finished");
    assert.strictEqual(tools(events)[0]?.state._tag, "Stopped");
    const markup = renderToStaticMarkup(
      <Transcript events={events} attempts={[liveAttempt]} filter="all" />,
    );
    assert.include(markup, "reviewer activity · Finished");
  });

  it("filters prose and tools while keeping Attempt notices and child status visible", () => {
    const events = [
      record(1, new AttemptChannel.Started({ parentModel: brain.model })),
      sessionEvent(2, new TextOutput({ session: parent, text: "A useful explanation" })),
      sessionEvent(
        3,
        new ToolStarted({
          session: parent,
          callId: "call-1",
          tool: "read",
          input: { path: "README.md" },
        }),
      ),
      sessionEvent(4, new TextOutput({ session: child, text: "Child explanation" })),
    ];
    const messages = renderToStaticMarkup(
      <Transcript events={events} attempts={[liveAttempt]} filter="messages" />,
    );
    const toolRows = renderToStaticMarkup(
      <Transcript events={events} attempts={[liveAttempt]} filter="tools" />,
    );
    assert.include(messages, "A useful explanation");
    assert.notInclude(messages, "read · Running");
    assert.include(toolRows, "read · Running");
    assert.notInclude(toolRows, "A useful explanation");
    for (const markup of [messages, toolRows]) {
      assert.include(markup, "Attempt started");
      assert.include(markup, brain.model);
      assert.include(markup, "reviewer activity · Working");
    }
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
      new TranscriptPageCursor({
        attemptId: firstAttempt,
        before: TranscriptSequence.make(100),
      }),
      new TranscriptPageCursor({
        attemptId: secondAttempt,
        before: TranscriptSequence.make(200),
      }),
    ];
    const replaced = replaceEarlierCursor(cursors, secondAttempt, [
      new TranscriptPageCursor({
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
    const key = ["run", "run-31"] as const;
    queryClient.setQueryDefaults(["run"], {
      structuralSharing: RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
    });
    queryClient.setQueryData(key, {
      earlierTranscript: [
        new TranscriptPageCursor({
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
            new TranscriptPageCursor({
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
    const cursor = new TranscriptPageCursor({ attemptId, before: TranscriptSequence.make(2) });
    const stale = new RunDetailView({
      run: new RunView({
        id: RunId.make("run-31"),
        itemKey: ItemKey.make("github:basaltbytes/usine:31"),
        loop: LoopName.make("develop"),
        repository: RepositoryName.make("basaltbytes/usine"),
        agent: parent.agent,
        state: "Running",
        loopPaused: false,
        openedAt: liveAttempt.startedAt,
        task: "Build it",
        attempts: [liveAttempt],
        resultMessage: null,
        pullRequestUrl: null,
        canApprove: false,
        canRetry: false,
        canCancel: true,
      }),
      eventDedupKey: "issue:31",
      eventPayload: { number: 31 },
      transcript: [event(1, "Earlier message")],
      earlierTranscript: [],
    });
    const current = new RunDetailView({
      ...stale,
      run: new RunView({
        ...stale.run,
        state: "Succeeded",
        attempts: [new AttemptView({ ...liveAttempt, outcome: new SucceededAttemptView() })],
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
});
