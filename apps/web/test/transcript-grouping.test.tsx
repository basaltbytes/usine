import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentName } from "@usine/core/agent";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  SessionFinished,
  TextOutput,
  ToolFinished,
  ToolStarted,
  type AgentSession,
  type AgentSessionEvent,
} from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { SessionEvent } from "@usine/core/attempt/channel";
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
        <Transcript events={events} attempts={[]} filter="all" />
      </MessageScrollerProvider>
    </TranscriptDisclosureProvider>,
  );

  assert.include(html, "Edited conversation.tsx · ran tests");
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
        <Transcript events={events} attempts={[]} filter="tools" />
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

it.each(["Running", "Error", "Stopped"] as const)(
  "keeps %s calls exposed between completed groups",
  (state) => {
    const events = [
      finished(1, "a"),
      finished(2, "b"),
      started(3, "inspect-me"),
      finished(4, "c"),
      finished(5, "d"),
    ];
    if (state === "Error")
      events.push(
        record(
          6,
          new ToolFinished({
            session: parent,
            callId: "inspect-me",
            tool: "read",
            output: "Access denied",
            isError: true,
          }),
        ),
      );
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
  assert.equal(summary(events), "Read core/src/model.ts, engine/src/model.ts");
  assert.equal(summary(events.slice(0, 2).concat(events.slice(4))), "Read model.ts");

  const mixed = [
    ...completed(1, "Read", { file_path: "core/src/model.ts" }),
    ...completed(3, "Edit", { file_path: "engine/src/model.ts", old_string: "a", new_string: "b" }),
  ];
  assert.equal(summary(mixed), "Read core/src/model.ts · edited engine/src/model.ts");
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
  assert.equal(summary(events), "Changed new.ts, old.ts · ran a build");
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
  assert.equal(groupSummary(cold), "1 file read · ran 1 command");
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
  assert.equal(groupSummary(loaded), "Read model.ts · ran tests");
  assert.equal(loaded.key, cold.key);
  assert.deepEqual(keys(loaded), keys(cold));
});

it("recognizes complete familiar commands without interpreting arguments or shell programs", () => {
  assert.equal(
    summary([
      ...completed(1, "Bash", { command: "npm run test" }),
      ...completed(3, "bash", { command: "cargo test" }),
      ...completed(5, "shell", { command: "pnpm --filter @usine/web test" }),
    ]),
    "Ran tests 3 times",
  );

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
  assert.equal(text, `Ran ${ambiguous.length} commands`);
  assert.notInclude(text, "private-value");
});

it("keeps missing inputs honest and bounds long paths and varied operations", () => {
  assert.equal(
    summary([...completed(1, "Read", { file_path: "src/known.ts" }), ...completed(3, "Read", {})]),
    "2 file reads",
  );

  assert.equal(
    summary([
      ...completed(1, "Write", { file_path: "src/a.ts", content: "a" }),
      ...completed(3, "write", { path: "src/b.ts", content: "b" }),
      ...completed(5, "write", { path: "src/c.ts", content: "c" }),
    ]),
    "Wrote 3 files",
  );

  assert.equal(
    summary([
      ...completed(1, "read", { path: "source.ts\n" }),
      ...completed(3, "read", { path: '{"token":"private-value"}' }),
    ]),
    "Read 2 files",
  );

  const longName = `${"long".repeat(30)}.ts`;
  assert.equal(
    summary([
      ...completed(1, "edit", { path: `a/${longName}` }),
      ...completed(3, "edit", { path: `b/${longName}` }),
    ]),
    "Edited 2 files",
  );

  const text = summary([
    ...completed(1, "edit", { path: "src/conversation.tsx" }),
    ...completed(3, "command", { command: "pnpm test" }),
    ...completed(5, "grep", { pattern: "private-query" }),
    ...completed(7, "subagent", { task: "private-task" }),
    ...completed(9, "unknown", { token: "private-token" }),
  ]);
  assert.equal(text, "Edited conversation.tsx · ran tests · 3 more calls");
});
