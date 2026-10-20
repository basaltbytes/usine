import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentName } from "@usine/core/agent";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  SessionFinished,
  SessionIdle,
  SessionStarted,
  TextOutput,
  ToolFinished,
  ToolStarted,
  type AgentSession,
  type AgentSessionEvent,
} from "@usine/core/agent/session";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { AttemptId } from "@usine/core/attempt";
import {
  Sequence,
  SessionEvent,
  Intervention,
  InterventionApplied,
  InterventionRejected,
  InterventionState,
  ChildTarget,
  OperatorMessage,
  ParentTarget,
} from "@usine/core/attempt/channel";
import { TranscriptSequence } from "@usine/engine/transcript";
import { RunView, TranscriptEventView } from "@usine/orchestrator/operator";
import type { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, it } from "vitest";
import { MessageScrollerProvider } from "../src/components/ui/message-scroller.tsx";
import { Outline } from "../src/run-page/outline.tsx";
import { readerDocument, type Burst } from "../src/run-transcript/document/model.ts";
import { burstSummary } from "../src/run-transcript/grouping/summary.ts";
import { projectTranscript, type TranscriptTool } from "../src/run-transcript/model.ts";
import { Transcript } from "../src/run-transcript/transcript.tsx";
import {
  changeDisclosure,
  isGroupOpen,
  TranscriptDisclosureProvider,
} from "../src/run-transcript/grouping/disclosure.tsx";

const brain = new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "high" });
const parent = new ParentSession({
  id: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain,
});
const attempt = AttemptId.make("first-attempt");

const record = (sequence: number, event: AgentSessionEvent, attemptId = attempt) =>
  new TranscriptEventView({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    receivedAt: new Date(Date.UTC(2026, 8, 6, 12, 0, sequence)).toISOString(),
    direction: "outbound",
    payload: new SessionEvent({ event }),
  });

const finished = (
  sequence: number,
  callId: string,
  tool = "read",
  session: AgentSession = parent,
  attemptId = attempt,
) =>
  record(
    sequence,
    new ToolFinished({ session, callId, tool, output: "Done", isError: false }),
    attemptId,
  );
const started = (sequence: number, callId: string) =>
  record(
    sequence,
    new ToolStarted({ session: parent, callId, tool: "read", input: { path: "src/index.ts" } }),
  );
const document = (events: ReadonlyArray<TranscriptEventView>) =>
  readerDocument(projectTranscript(events, []), [], events);
const groups = (events: ReadonlyArray<TranscriptEventView>): ReadonlyArray<Burst> =>
  document(events)
    .chapters.flatMap((chapter) => chapter.rows)
    .filter((row): row is Burst => row._tag === "Burst");
const keys = (group: Burst) => group.tools.map((tool) => tool.key);
const history = { cursors: [], loading: false, error: null, load: () => {} };
const render = (events: ReadonlyArray<TranscriptEventView>) =>
  renderToStaticMarkup(
    <TranscriptDisclosureProvider>
      <MessageScrollerProvider>
        <Transcript document={document(events)} runTask="Task" history={history} />
      </MessageScrollerProvider>
    </TranscriptDisclosureProvider>,
  );
const completed = (
  sequence: number,
  tool: string,
  input: Schema.Json,
  output: Schema.Json = "Done",
) => {
  const callId = `call-${sequence}`;
  return [
    record(sequence, new ToolStarted({ session: parent, callId, tool, input })),
    record(
      sequence + 1,
      new ToolFinished({ session: parent, callId, tool, output, isError: false }),
    ),
  ];
};
// Summarizes every call, delegations included, as one burst would.
const summary = (events: ReadonlyArray<TranscriptEventView>) => {
  const [first, ...rest] = projectTranscript(events, [])
    .sessions.flatMap(({ entries }) => entries)
    .filter((entry): entry is TranscriptTool => entry._tag === "Tool")
    .sort((left, right) => left.sequence - right.sequence);
  assert.isDefined(first);
  return burstSummary({ tools: [first, ...rest] });
};

it("folds the calls between two messages into one line that says what ran", () => {
  const events = [
    ...completed(1, "edit", {
      path: "src/conversation.tsx",
      edits: [{ oldText: "before", newText: "after" }],
    }),
    ...completed(3, "Bash", { command: "pnpm test" }, [{ type: "text", text: "One test failed" }]),
    record(5, new TextOutput({ session: parent, text: "The checks need attention." })),
    finished(6, "after-message", "shell"),
  ];
  const html = render(events);

  // This one exact example verifies the compact separator and sentence casing.
  assert.include(html, "Edited conversation.tsx · ran tests");
  assert.notMatch(summary(events), /\b(?:passed|succeeded|successful)\b/iu);
  assert.include(html, "2 tool calls");
  assert.include(html, "The checks need attention.");
  assert.include(html, "Ran 1 command");
  assert.notInclude(html, 'aria-label="Command: Command details unavailable · Completed"');
  assert.ok(html.indexOf("Edited conversation.tsx") < html.indexOf("The checks need attention."));
  assert.ok(html.indexOf("The checks need attention.") < html.indexOf("Ran 1 command"));
  assert.deepEqual(
    groups(events).map((group) => group.tools.length),
    [2, 1],
  );
});

it("times a burst from its first start to its last result and counts failed and running calls", () => {
  const events = [
    ...completed(1, "Bash", { command: "pnpm lint" }),
    record(
      3,
      new ToolStarted({ session: parent, callId: "gate", tool: "Bash", input: { command: "x" } }),
    ),
    record(
      28,
      new ToolFinished({
        session: parent,
        callId: "gate",
        tool: "Bash",
        output: "no",
        isError: true,
      }),
    ),
    record(
      29,
      new ToolStarted({ session: parent, callId: "live", tool: "Bash", input: { command: "y" } }),
    ),
  ];
  const html = render(events);
  assert.include(html, "Ran 3 commands");
  assert.match(html, /, (?:<!-- -->)?1(?:<!-- -->)? failed/u);
  assert.match(html, /, (?:<!-- -->)?1(?:<!-- -->)? running/u);
  assert.include(html, ">27s<");
});

it("does not join calls across a message", () => {
  const events = [
    finished(1, "a"),
    finished(2, "b"),
    record(3, new TextOutput({ session: parent, text: "A new step." })),
    finished(4, "c"),
    finished(5, "d"),
  ];
  const html = render(events);

  assert.lengthOf(html.match(/2 file reads/gu) ?? [], 2);
  assert.notInclude(html, "4 file reads");
});

it("keeps completed calls within their parent session, child session and Attempt", () => {
  const secondParent = new ParentSession({
    id: AgentSessionId.make("other-parent"),
    agent: parent.agent,
    brain,
  });
  const child = new ChildSession({
    id: AgentSessionId.make("child"),
    parentId: parent.id,
    agent: AgentName.make("reviewer"),
    brain,
  });
  const retry = AttemptId.make("retry");
  const events = [
    finished(1, "a"),
    finished(2, "b"),
    finished(3, "a", "read", secondParent),
    finished(4, "b", "read", secondParent),
    finished(5, "a", "read", child),
    finished(6, "b", "read", child),
    finished(7, "a", "read", parent, retry),
    finished(8, "b", "read", parent, retry),
  ];
  const bursts = groups(events);
  assert.deepEqual(
    bursts.map((group) => group.tools.length),
    [2, 2, 2, 2],
  );
  assert.equal(new Set(bursts.flatMap(keys)).size, 8);
  assert.deepEqual(
    bursts.map((group) => group.speaker.name),
    ["Parent", "Parent", "reviewer", "Parent"],
  );
  assert.lengthOf(document(events).chapters, 2);
});

it("groups failed commands with the adjacent completed commands and preserves their errors", () => {
  const projection = groups([
    finished(1, "before", "shell"),
    record(
      2,
      new ToolFinished({
        session: parent,
        callId: "failed",
        tool: "shell",
        output: "Access denied",
        isError: true,
      }),
    ),
    finished(3, "after", "shell"),
  ]);
  assert.lengthOf(projection, 1);
  const group = projection[0];
  assert.isDefined(group);
  assert.equal(burstSummary(group), "Ran 3 commands");
  assert.deepEqual(
    group.tools.map(({ state }) => state._tag),
    ["Finished", "Error", "Finished"],
  );
  const failed = group.tools[1]?.state;
  assert(failed?._tag === "Error");
  assert.equal(failed.output, "Access denied");
});

it.each(["Running", "Stopped"] as const)(
  "folds %s calls into the burst between two messages",
  (state) => {
    const events = [
      finished(1, "a"),
      finished(2, "b"),
      started(3, "inspect-me"),
      finished(4, "c"),
      finished(5, "d"),
    ];
    if (state === "Stopped") events.push(record(6, new SessionFinished({ session: parent })));
    const bursts = groups(events);

    assert.deepEqual(
      bursts.map((group) => group.tools.length),
      [5],
    );
    assert.equal(bursts[0]?.tools[2]?.state._tag, state);
  },
);

it("keeps an inspected running call expanded when it completes and more calls join its burst", () => {
  const initial = [finished(1, "a"), finished(2, "b"), started(3, "live")];
  const tool = projectTranscript(initial, []).items.find(
    (item) => item._tag === "Tool" && item.state._tag === "Running",
  );
  assert.isDefined(tool);
  const choice = changeDisclosure(new Map(), { _tag: "Item", key: tool.key, open: true });
  const completed = groups([...initial, finished(4, "live"), finished(5, "c")])[0];
  assert.isDefined(completed);

  assert.isTrue(isGroupOpen(choice, keys(completed)));
  assert.isTrue(choice.get(tool.key)?.open);
  assert.include(keys(completed), tool.key);
});

it("retains group and tool choices when history grows and the group is collapsed then reopened", () => {
  const coldEvents = [finished(5, "a"), finished(6, "b")];
  const cold = groups(coldEvents)[0];
  assert.isDefined(cold);
  const opened = changeDisclosure(new Map(), { _tag: "Group", keys: keys(cold), open: true });
  const inspected = changeDisclosure(opened, { _tag: "Item", key: cold.tools[0].key, open: true });
  const expanded = groups([finished(1, "earlier"), ...coldEvents, finished(7, "later")])[0];
  assert.isDefined(expanded);
  assert.isTrue(isGroupOpen(inspected, keys(expanded)));

  const closed = changeDisclosure(inspected, { _tag: "Group", keys: keys(expanded), open: false });
  assert.isFalse(isGroupOpen(closed, keys(expanded)));
  assert.isTrue(closed.get(cold.tools[0].key)?.open);
  const reopened = changeDisclosure(closed, { _tag: "Group", keys: keys(expanded), open: true });
  assert.isTrue(isGroupOpen(reopened, keys(expanded)));
  assert.isTrue(reopened.get(cold.tools[0].key)?.open);
});

it("counts repeated reads as one file and distinguishes colliding basenames", () => {
  const events = [
    ...completed(1, "read", { path: "packages/core/src/model.ts", offset: 1, limit: 8 }),
    ...completed(3, "Read", { file_path: "packages/engine/src/model.ts" }),
    ...completed(5, "read", { path: "packages/core/src/model.ts", offset: 48, limit: 8 }),
  ];
  const reads = summary(events);
  assert.include(reads, "core/src/model.ts");
  assert.include(reads, "engine/src/model.ts");
  assert.lengthOf(reads.match(/model\.ts/gu) ?? [], 2);
  const repeated = summary(events.slice(0, 2).concat(events.slice(4)));
  assert.include(repeated, "model.ts");
  assert.lengthOf(repeated.match(/model\.ts/gu) ?? [], 1);

  const mixed = [
    ...completed(1, "Read", { file_path: "core/src/model.ts" }),
    ...completed(3, "Edit", { file_path: "engine/src/model.ts", old_string: "a", new_string: "b" }),
  ];
  const actions = summary(mixed);
  assert.include(actions, "core/src/model.ts");
  assert.include(actions, "engine/src/model.ts");
  assert.match(actions, /\bread\b/iu);
  assert.match(actions, /\bedit(?:ed|s)?\b/iu);
});

it("uses Codex result evidence for multiple changed files and commands before their starts are loaded", () => {
  const events = [
    record(
      3,
      new ToolFinished({
        session: parent,
        callId: "files",
        tool: "file_change",
        isError: false,
        output: {
          type: "fileChange",
          status: "completed",
          changes: [
            { path: "src/new.ts", kind: { type: "add" }, diff: "+new" },
            { path: "src/old.ts", kind: { type: "delete" }, diff: "-old" },
          ],
        },
      }),
    ),
    record(
      4,
      new ToolFinished({
        session: parent,
        callId: "command",
        tool: "command",
        isError: false,
        output: {
          type: "commandExecution",
          command: "pnpm build",
          status: "completed",
          exitCode: 1,
          aggregatedOutput: "Build failed",
        },
      }),
    ),
  ];
  const text = summary(events);
  assert.include(text, "new.ts");
  assert.include(text, "old.ts");
  assert.match(text, /\bbuilds?\b/iu);
  assert.notMatch(text, /\b(?:passed|succeeded|successful)\b/iu);
});

it("enriches summaries when older starts arrive without changing tool identities or membership", () => {
  const recent = [
    finished(3, "read"),
    record(
      4,
      new ToolFinished({
        session: parent,
        callId: "test",
        tool: "bash",
        output: "Test failed",
        isError: false,
      }),
    ),
  ];
  const cold = groups(recent)[0];
  assert.isDefined(cold);
  assert.match(burstSummary(cold), /\bread\b/iu);
  assert.match(burstSummary(cold), /\bcommands?\b/iu);
  assert.notMatch(burstSummary(cold), /\btests?\b/iu);
  const earlier = [
    record(
      1,
      new ToolStarted({
        session: parent,
        callId: "read",
        tool: "read",
        input: { path: "src/model.ts" },
      }),
    ),
    record(
      2,
      new ToolStarted({
        session: parent,
        callId: "test",
        tool: "bash",
        input: { command: "pnpm test" },
      }),
    ),
  ];
  const loaded = groups([...earlier, ...recent])[0];
  assert.isDefined(loaded);
  assert.include(burstSummary(loaded), "model.ts");
  assert.match(burstSummary(loaded), /\btests?\b/iu);
  assert.equal(loaded.key, cold.key);
  assert.deepEqual(keys(loaded), keys(cold));
});

it("recognizes complete familiar commands without interpreting arguments or shell programs", () => {
  const recognized = summary([
    ...completed(1, "Bash", { command: "npm run test" }),
    ...completed(3, "bash", { command: "cargo test" }),
    ...completed(5, "shell", { command: "pnpm --filter @usine/web test" }),
  ]);
  assert.match(recognized, /\btests?\b/iu);
  assert.match(recognized, /\b3\b/u);

  const ambiguous = [
    'echo "pnpm test"',
    "pnpm test:watch",
    "pnpm build && pnpm test",
    "pnpm test --token=private-value",
    "TEST_TOKEN=private-value pnpm test",
    "python scripts/test.py",
    "pnpm test\npnpm build",
    "pnpm --filter @usine/web test:watch",
    "pnpm --filter @usine/web test && echo private-value",
  ];
  const events = ambiguous.flatMap((command, index) =>
    completed(index * 2 + 1, "shell", { command }),
  );
  const text = summary(events);
  assert.include(text, String(ambiguous.length));
  assert.match(text, /\bcommands?\b/iu);
  assert.notMatch(text, /\b(?:tests?|builds?)\b/iu);
  assert.notInclude(text, "private-value");
});

it("keeps missing inputs honest and bounds long paths and varied operations", () => {
  const incomplete = summary([
    ...completed(1, "Read", { file_path: "src/known.ts" }),
    ...completed(3, "Read", {}),
  ]);
  assert.match(incomplete, /\b2\b/u);
  assert.match(incomplete, /\breads?\b/iu);
  assert.notMatch(incomplete, /\b2 files\b/iu);

  const writes = summary([
    ...completed(1, "Write", { file_path: "src/a.ts", content: "a" }),
    ...completed(3, "write", { path: "src/b.ts", content: "b" }),
    ...completed(5, "write", { path: "src/c.ts", content: "c" }),
  ]);
  assert.match(writes, /\b3 files\b/iu);

  const unsafePaths = summary([
    ...completed(1, "read", { path: "source.ts\n" }),
    ...completed(3, "read", { path: '{"token":"private-value"}' }),
  ]);
  assert.match(unsafePaths, /\b2 files\b/iu);
  assert.notInclude(unsafePaths, "private-value");
  assert.notInclude(unsafePaths, "\n");

  const longName = `${"long".repeat(30)}.ts`;
  const longPaths = summary([
    ...completed(1, "edit", { path: `a/${longName}` }),
    ...completed(3, "edit", { path: `b/${longName}` }),
  ]);
  assert.match(longPaths, /\b2 files\b/iu);
  assert.notInclude(longPaths, longName);

  const text = summary([
    ...completed(1, "edit", { path: "src/conversation.tsx" }),
    ...completed(3, "command", { command: "pnpm test" }),
    ...completed(5, "grep", { pattern: "private-query" }),
    ...completed(7, "subagent", { task: "private-task" }),
    ...completed(9, "unknown", { token: "private-token" }),
  ]);
  assert.include(text, "conversation.tsx");
  assert.match(text, /\btests?\b/iu);
  assert.match(text, /\b3\b/u);
  assert.match(text, /\bcalls?\b/iu);
  assert.notInclude(text, "private-");
});

it("summarizes a large file change by distinct-file count while preserving every recorded change", () => {
  const repeated = { path: "src/file-0.ts", kind: { type: "update" }, diff: "+private-source" };
  const changes = [
    repeated,
    ...Array.from({ length: 4999 }, (_, index) => ({
      ...repeated,
      path: `src/file-${index + 1}.ts`,
    })),
    repeated,
  ];
  const output = { type: "fileChange", status: "completed", changes };
  const group = groups([
    ...completed(1, "file_change", {}, output),
    ...completed(3, "command", { command: "pnpm test" }),
  ])[0];
  assert.isDefined(group);

  const text = burstSummary(group);
  assert.match(text, /\b5000 files\b/iu);
  assert.match(text, /\btests?\b/iu);
  assert.isBelow(text.length, 100);
  assert.notInclude(text, "private-source");
  assert.lengthOf(group.tools, 2);
  const change = group.tools[0].state;
  assert(change._tag === "Finished");
  assert.deepEqual(change.output, output);
});

it("uses a file count when deeply nested colliding paths cannot be distinguished in a compact label", () => {
  const shared = `${"nested/".repeat(5000)}model.ts`;
  const text = summary([
    ...completed(1, "read", { path: `core/${shared}` }),
    ...completed(3, "read", { path: `engine/${shared}` }),
  ]);

  assert.match(text, /\b2 files\b/iu);
  assert.notInclude(text, "model.ts");
  assert.isBelow(text.length, 100);
});

it("attaches paged input to its child using unpaged session identity without replaying history", () => {
  const child = new ChildSession({
    id: AgentSessionId.make("held-child"),
    parentId: parent.id,
    agent: parent.agent,
    brain,
  });
  const intervention = new Intervention({
    operator: "Philippe",
    target: new ChildTarget({ sessionId: child.id }),
    action: new OperatorMessage({ message: "Keep this correction" }),
  });
  const receipt = new TranscriptEventView({
    sequence: TranscriptSequence.make(9),
    attemptId: attempt,
    receivedAt: "2026-09-12",
    direction: "outbound",
    payload: new InterventionRejected({
      inputSequence: Sequence.make(2),
      intervention,
      message: "Harness unavailable",
    }),
  });
  const held = new TranscriptEventView({
    ...receipt,
    sequence: TranscriptSequence.make(7),
    payload: new InterventionApplied({
      inputSequence: Sequence.make(1),
      intervention,
      state: new InterventionState({ held: true, paused: false }),
    }),
  });
  const projection = projectTranscript(
    [receipt],
    [],
    [held, record(8, new SessionIdle({ session: child }))],
  );
  assert.strictEqual(projection.items.length, 1);
  const session = projection.sessions[0];
  assert(session !== undefined);
  assert.strictEqual(session.held, true);
  assert.strictEqual(session.idle, true);
  assert.strictEqual(session.entries.length, 1);
  const entry = session.entries[0];
  assert(entry?._tag === "Notice");
  assert.strictEqual(entry.detail, "Keep this correction\n\nHarness unavailable");
  assert.strictEqual(entry.tone, "failed");
  const unmatched = projectTranscript([receipt], []).items[0];
  assert(unmatched?._tag === "Notice");
  assert.include(unmatched.label, child.id);
  assert.strictEqual(unmatched.detail, entry.detail);
});

it("renders a held child from session state when its activity is outside the loaded page", () => {
  const child = new ChildSession({
    id: AgentSessionId.make("off-page-child"),
    parentId: parent.id,
    agent: parent.agent,
    brain,
  });
  const held = new TranscriptEventView({
    sequence: TranscriptSequence.make(3),
    attemptId: attempt,
    receivedAt: "2026-09-12",
    direction: "outbound",
    payload: new InterventionApplied({
      inputSequence: Sequence.make(1),
      intervention: new Intervention({
        operator: "Philippe",
        target: new ChildTarget({ sessionId: child.id }),
        action: new OperatorMessage({ message: "Review this with me" }),
      }),
      state: new InterventionState({ held: true, paused: false }),
    }),
  });
  const page = [record(20, new TextOutput({ session: parent, text: "Waiting on the child." }))];
  const run = new RunView({
    id: RunId.make("run-31"),
    itemKey: ItemKey.make("item"),
    loop: LoopName.make("implement"),
    repository: RepositoryName.make("basaltbytes/usine"),
    agent: parent.agent,
    state: "Running",
    loopPaused: false,
    openedAt: "2026-09-12",
    task: "Task",
    attempts: [],
    approval: null,
    runAgain: null,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: false,
    canRetry: false,
    canResolveFailure: false,
    canCancel: true,
    canRunAgain: false,
  });
  const outline = (sessionState: ReadonlyArray<TranscriptEventView>) =>
    renderToStaticMarkup(
      <Outline
        run={run}
        eventPreview="Event"
        document={readerDocument(projectTranscript(page, [], sessionState), [], page)}
        selection={{ _tag: "Attempt", attemptId: attempt, sessionKey: null }}
        reading={null}
        composerSession={null}
        onSelect={() => {}}
        onCheckpoint={() => {}}
        errors={null}
      />,
    );

  const reachable = outline([held, record(4, new SessionIdle({ session: child }))]);
  assert.include(reachable, "Held, waiting for input");
  assert.include(reachable, 'aria-label="Resume details for developer"');
  assert.notInclude(outline([]), "Held, waiting for input");
  assert.notInclude(outline([]), "Resume details for developer");
});

it("shows an operator message to a delegating parent once, queued until the parent reads it or stops", () => {
  const intervention = new Intervention({
    operator: "Philippe",
    target: new ParentTarget(),
    action: new OperatorMessage({ message: "What failed earlier?" }),
  });
  const receipt = (sequence: number, payload: InterventionApplied | InterventionRejected) =>
    new TranscriptEventView({
      sequence: TranscriptSequence.make(sequence),
      attemptId: attempt,
      receivedAt: new Date(Date.UTC(2026, 8, 6, 12, 0, sequence)).toISOString(),
      direction: "outbound",
      payload,
    });
  const applied = (sequence: number, queued: boolean) =>
    receipt(
      sequence,
      new InterventionApplied({
        inputSequence: Sequence.make(1),
        intervention,
        state: new InterventionState({ held: true, paused: false, queued }),
      }),
    );
  const delegating = [
    record(1, new TextOutput({ session: parent, text: "Delegating the fix." })),
    applied(2, true),
  ];
  const operatorRows = (events: ReadonlyArray<TranscriptEventView>) =>
    document(events)
      .chapters.flatMap((chapter) => chapter.rows)
      .flatMap((row) =>
        row._tag === "Message" && row.speaker.name === "Philippe"
          ? [[Number(row.sequence), row.queued, row.undelivered]]
          : [],
      );

  assert.deepStrictEqual(operatorRows(delegating), [[2, "parent", false]]);
  assert.deepStrictEqual(operatorRows([...delegating, applied(5, false)]), [[2, null, false]]);
  const stopped = receipt(
    5,
    new InterventionRejected({
      inputSequence: Sequence.make(1),
      intervention,
      message: "The parent stopped before it read this message.",
    }),
  );
  assert.deepStrictEqual(operatorRows([...delegating, stopped]), [[2, null, true]]);
});

it("shows a message to a working child queued in the child's section until the child reads it", () => {
  const child = new ChildSession({
    id: AgentSessionId.make("working-child"),
    parentId: parent.id,
    agent: parent.agent,
    brain,
  });
  const intervention = new Intervention({
    operator: "Philippe",
    target: new ChildTarget({ sessionId: child.id }),
    action: new OperatorMessage({ message: "Use pnpm, not npm." }),
  });
  const applied = (sequence: number, queued: boolean) =>
    new TranscriptEventView({
      sequence: TranscriptSequence.make(sequence),
      attemptId: attempt,
      receivedAt: new Date(Date.UTC(2026, 8, 6, 12, 0, sequence)).toISOString(),
      direction: "outbound",
      payload: new InterventionApplied({
        inputSequence: Sequence.make(1),
        intervention,
        state: new InterventionState({ held: true, paused: false, queued }),
      }),
    });
  const working = [
    record(1, new SessionStarted({ session: child })),
    record(2, new TextOutput({ session: child, text: "Running the tests." })),
    applied(3, true),
  ];
  const queuedOf = (events: ReadonlyArray<TranscriptEventView>) => {
    const session = projectTranscript(events, []).sessions.find(
      (candidate) => candidate.session.id === child.id,
    );
    assert(session !== undefined);
    assert.isTrue(session.held);
    return session.entries.flatMap((entry) =>
      entry._tag === "Notice" && entry.origin._tag === "Operator" ? [entry.queued] : [],
    );
  };

  assert.deepStrictEqual(queuedOf(working), ["child"]);
  assert.include(render(working), "Queued until the child&#x27;s current step ends");
  assert.deepStrictEqual(queuedOf([...working, applied(6, false)]), [null]);
  assert.notInclude(render([...working, applied(6, false)]), "Queued until");
});
