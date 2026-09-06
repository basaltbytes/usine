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
import { renderToStaticMarkup } from "react-dom/server";
import { assert, it } from "vitest";
import { MessageScrollerProvider } from "../src/components/ui/message-scroller.tsx";
import { projectTranscript } from "../src/run-transcript/model.ts";
import { Transcript } from "../src/run-transcript/transcript.tsx";
import { groupTranscript, type ToolGroup } from "../src/run-transcript/grouping/model.ts";
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

it("summarizes adjacent completed work while keeping prose and a single call visible", () => {
  const events = [
    finished(1, "read-a"),
    finished(2, "read-b"),
    finished(3, "command", "shell"),
    record(4, new TextOutput({ session: parent, text: "The checks passed." })),
    finished(5, "after-message", "shell"),
  ];
  const html = renderToStaticMarkup(
    <TranscriptDisclosureProvider>
      <MessageScrollerProvider>
        <Transcript events={events} attempts={[]} filter="all" />
      </MessageScrollerProvider>
    </TranscriptDisclosureProvider>,
  );

  assert.include(html, "2 file reads · 1 command");
  assert.include(html, "The checks passed.");
  assert.include(html, 'aria-label="Command: Command details unavailable · Completed"');
  assert.ok(html.indexOf("2 file reads") < html.indexOf("The checks passed."));
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
