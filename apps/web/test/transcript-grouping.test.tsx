import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentName } from "@usine/core/agent";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  SessionFinished,
  SessionIdle,
  TextOutput,
  ToolFinished,
  ToolStarted,
  type AgentSession,
  type AgentSessionEvent,
} from "@usine/core/agent/session";
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
} from "@usine/core/attempt/channel";
import { TranscriptSequence } from "@usine/engine/transcript";
import { TranscriptEventView } from "@usine/orchestrator/operator";
import type { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, it } from "vitest";
import { MessageScrollerProvider } from "../src/components/ui/message-scroller.tsx";
import { projectTranscript } from "../src/run-transcript/model.ts";
import { Transcript } from "../src/run-transcript/transcript.tsx";
import {
  groupSummary,
  groupTranscript,
  type ToolGroup,
} from "../src/run-transcript/grouping/model.ts";
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
const groups = (events: ReadonlyArray<TranscriptEventView>): ReadonlyArray<ToolGroup> =>
  groupTranscript(projectTranscript(events, [])).filter((item) => item._tag === "ToolGroup");
const keys = (group: ToolGroup) => group.tools.map((tool) => tool.key);
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
const summary = (events: ReadonlyArray<TranscriptEventView>) => {
  const group = groups(events)[0];
  assert.isDefined(group);
  return groupSummary(group);
};

it("summarizes adjacent completed work while keeping prose and a single call visible", () => {
  const events = [
    ...completed(1, "edit", {
      path: "src/conversation.tsx",
      edits: [{ oldText: "before", newText: "after" }],
    }),
    ...completed(3, "Bash", { command: "pnpm test" }, [{ type: "text", text: "One test failed" }]),
    record(5, new TextOutput({ session: parent, text: "The checks need attention." })),
    finished(6, "after-message", "shell"),
  ];
  const html = renderToStaticMarkup(
    <TranscriptDisclosureProvider>
      <MessageScrollerProvider>
        <Transcript
          runId={RunId.make("run-31")}
          projection={projectTranscript(events, [])}
          filter="all"
        />
      </MessageScrollerProvider>
    </TranscriptDisclosureProvider>,
  );

  // This one exact example verifies the compact separator and sentence casing.
  assert.include(html, "Edited conversation.tsx · ran tests");
  assert.notMatch(summary(events), /\b(?:passed|succeeded|successful)\b/iu);
  assert.include(html, "2 completed tools");
  assert.include(html, "The checks need attention.");
  assert.include(html, 'aria-label="Command: Command details unavailable · Completed"');
  assert.ok(html.indexOf("Edited conversation.tsx") < html.indexOf("The checks need attention."));
});

it("does not join successful calls across prose hidden by the tools filter", () => {
  const events = [
    finished(1, "a"),
    finished(2, "b"),
    record(3, new TextOutput({ session: parent, text: "A new step." })),
    finished(4, "c"),
    finished(5, "d"),
  ];
  const html = renderToStaticMarkup(
    <TranscriptDisclosureProvider>
      <MessageScrollerProvider>
        <Transcript
          runId={RunId.make("run-31")}
          projection={projectTranscript(events, [])}
          filter="tools"
        />
      </MessageScrollerProvider>
    </TranscriptDisclosureProvider>,
  );

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
  const projection = groupTranscript(
    projectTranscript(
      [
        finished(1, "a"),
        finished(2, "b"),
        finished(3, "a", "read", secondParent),
        finished(4, "b", "read", secondParent),
        finished(5, "a", "read", parent, retry),
        finished(6, "b", "read", parent, retry),
        finished(7, "a", "read", child),
        finished(8, "b", "read", child),
      ],
      [],
    ),
  );
  const parentGroups = projection.filter((item) => item._tag === "ToolGroup");
  assert.lengthOf(parentGroups, 3);
  assert.deepEqual(
    parentGroups.map((group) => group.tools.length),
    [2, 2, 2],
  );
  assert.equal(new Set(parentGroups.flatMap(keys)).size, 6);
  const childGroup = projection.find((item) => item._tag === "Session");
  assert.isDefined(childGroup);
  assert.equal(childGroup.session.id, child.id);
  assert.equal(childGroup.entries[0]?._tag, "ToolGroup");
});

it("groups failed commands with the adjacent completed commands and preserves their errors", () => {
  const projection = groupTranscript(
    projectTranscript(
      [
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
      ],
      [],
    ),
  );
  assert.lengthOf(projection, 1);
  const group = projection[0];
  assert.equal(group?._tag, "ToolGroup");
  if (group?._tag !== "ToolGroup") return;
  assert.equal(groupSummary(group), "Ran 3 commands");
  assert.deepEqual(
    group.tools.map(({ state }) => state._tag),
    ["Finished", "Error", "Finished"],
  );
  assert.equal(group.tools[1].state.output, "Access denied");
});

it.each(["Running", "Stopped"] as const)(
  "keeps %s calls exposed between completed groups",
  (state) => {
    const events = [
      finished(1, "a"),
      finished(2, "b"),
      started(3, "inspect-me"),
      finished(4, "c"),
      finished(5, "d"),
    ];
    if (state === "Stopped") events.push(record(6, new SessionFinished({ session: parent })));
    const projection = groupTranscript(projectTranscript(events, []));
    const standalone = projection.filter((item) => item._tag === "Tool");

    assert.lengthOf(standalone, 1);
    assert.equal(standalone[0]?.state._tag, state);
    assert.deepEqual(
      projection.filter((item) => item._tag === "ToolGroup").map((group) => group.tools.length),
      [2, 2],
    );
  },
);

it("keeps an inspected running call expanded when its completion joins a group", () => {
  const initial = [finished(1, "a"), finished(2, "b"), started(3, "live")];
  const tool = projectTranscript(initial, []).items.find(
    (item) => item._tag === "Tool" && item.state._tag === "Running",
  );
  assert.isDefined(tool);
  const choice = changeDisclosure(new Map(), { _tag: "Item", key: tool.key, open: true });
  const completed = groups([...initial, finished(4, "live")])[0];
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
  assert.match(groupSummary(cold), /\bread\b/iu);
  assert.match(groupSummary(cold), /\bcommands?\b/iu);
  assert.notMatch(groupSummary(cold), /\btests?\b/iu);
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
  assert.include(groupSummary(loaded), "model.ts");
  assert.match(groupSummary(loaded), /\btests?\b/iu);
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

  const text = groupSummary(group);
  assert.match(text, /\b5000 files\b/iu);
  assert.match(text, /\btests?\b/iu);
  assert.isBelow(text.length, 100);
  assert.notInclude(text, "private-source");
  assert.lengthOf(group.tools, 2);
  assert.deepEqual(group.tools[0].state.output, output);
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
  assert.strictEqual(entry.isError, true);
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
  const render = (sessionState: ReadonlyArray<TranscriptEventView>) =>
    renderToStaticMarkup(
      <TranscriptDisclosureProvider>
        <MessageScrollerProvider>
          <Transcript
            runId={RunId.make("run-31")}
            projection={projectTranscript(page, [], sessionState)}
            filter="all"
          />
        </MessageScrollerProvider>
      </TranscriptDisclosureProvider>,
    );

  assert.include(
    render([held, record(4, new SessionIdle({ session: child }))]),
    "developer activity · Held · waiting for you",
  );
  assert.notInclude(render([]), "developer activity");
});
