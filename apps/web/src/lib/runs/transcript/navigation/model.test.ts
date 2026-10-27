import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  TextOutput,
  ToolFinished,
  ToolStarted,
  type AgentSession,
  type AgentSessionEvent,
} from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { SessionEvent } from "@usine/core/attempt/channel";
import { TranscriptSequence } from "@usine/engine/transcript";
import {
  AgentFailureView,
  FailedTranscriptView,
  TranscriptEventView,
} from "@usine/orchestrator/operator";
import { Option } from "effect";
import { assert, describe, it } from "vitest";
import { readerDocument } from "~/lib/runs/transcript/document/model";
import { projectTranscript } from "~/lib/runs/transcript/model";
import { locateReadingAnchor, readingRows } from "~/lib/runs/transcript/reader/anchor";
import { ReadingAnchor } from "~/lib/runs/transcript/reader/memory";
import {
  acknowledgeUnread,
  advanceUnread,
  indexTranscriptUpdates,
  initializeUnread,
} from "~/lib/runs/transcript/navigation/model";

const attemptId = AttemptId.make("attempt");
const brain = new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "high" });
const parent = new ParentSession({
  id: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain,
});
const child = new ChildSession({
  id: AgentSessionId.make("child"),
  parentId: parent.id,
  agent: AgentName.make("reviewer"),
  brain,
});
const record = (sequence: number, payload: TranscriptEventView["payload"]) =>
  new TranscriptEventView({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    receivedAt: new Date(Date.UTC(2026, 8, 6, 12, 0, sequence)).toISOString(),
    direction: "outbound",
    payload,
  });
const event = (sequence: number, event: AgentSessionEvent) =>
  record(sequence, new SessionEvent({ event }));
const message = (sequence: number, session: AgentSession = parent) =>
  event(sequence, new TextOutput({ session, text: `Activity ${sequence}` }));
const started = (sequence: number, session: AgentSession = parent) =>
  event(
    sequence,
    new ToolStarted({ session, callId: "call", tool: "read", input: { path: "README.md" } }),
  );
const finished = (sequence: number, session: AgentSession = parent, isError = false) =>
  event(
    sequence,
    new ToolFinished({ session, callId: "call", tool: "read", output: "Result", isError }),
  );
const meter = (sequence: number) =>
  event(
    sequence,
    new PoolRateLimitsUpdated({
      session: parent,
      pool: "chatgptPlan",
      rateLimits: new RateLimitsSnapshot({
        limitId: Option.none(),
        limitName: Option.none(),
        primary: Option.none(),
        secondary: Option.none(),
      }),
    }),
  );
const document = (events: ReadonlyArray<TranscriptEventView>) =>
  readerDocument(projectTranscript(events, []), [], events);
const index = (events: ReadonlyArray<TranscriptEventView>) =>
  indexTranscriptUpdates(document(events));
const through = (events: ReadonlyArray<TranscriptEventView>) => events.at(-1)?.sequence ?? null;

describe("conversation update index", () => {
  it("indexes original parent and child rows once, keeping call order when results arrive", () => {
    const events = [
      message(1),
      started(2),
      started(3, child),
      message(4, child),
      finished(5),
      finished(6, child),
      meter(7),
    ];
    const rows = index(events);
    assert.deepEqual(
      rows.map((row) => row.sequence),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      rows.map((row) => row.latestSequence),
      [1, 5, 6, 4],
    );
    assert.equal(new Set(rows.map((row) => row.key)).size, 4);
    assert.deepEqual(
      document(events).chapters[0]?.rows.map((row) =>
        row._tag === "Message" || row._tag === "Burst" ? row.speaker.name : null,
      ),
      ["Parent", "Parent", "reviewer", "reviewer"],
    );
    assert.deepEqual(
      rows.map((row) => row.isTool),
      [false, true, true, false],
    );
  });

  it("retains a result's identity and latest update when its earlier start is loaded", () => {
    const cold = index([finished(5)])[0];
    const withStart = index([started(2), finished(5)])[0];
    assert.isDefined(cold);
    assert.isDefined(withStart);
    assert.equal(withStart.key, cold.key);
    assert.equal(withStart.sequence, 2);
    assert.equal(withStart.latestSequence, cold.latestSequence);
  });

  it("targets recorded tool and Attempt errors without labeling stopped calls as errors", () => {
    const rows = index([
      started(1),
      started(2, child),
      finished(3, child, true),
      record(4, new FailedTranscriptView({ failure: new AgentFailureView({ message: "Failed" }) })),
    ]);
    const errors = rows.filter((row) => row.isError);
    assert.deepEqual(
      errors.map((row) => row.sequence),
      [2, 4],
    );
    assert.deepEqual(
      errors.map((row) => row.isTool),
      [true, false],
    );
  });
});

describe("unread conversation activity", () => {
  it("counts a new call once across its start, completion and repeated polls", () => {
    const initial = [message(1)];
    const pending = [...initial, started(2)];
    const completed = [...pending, finished(3)];
    const baseline = initializeUnread(through(initial));
    const running = advanceUnread(baseline, index(pending), through(pending));
    const done = advanceUnread(running, index(completed), through(completed));
    const repeated = advanceUnread(done, index(completed), through(completed));

    assert.equal(running.keys.size, 1);
    assert.deepEqual(done.keys, running.keys);
    assert.deepEqual(repeated.keys, running.keys);
    assert.equal(baseline.keys.size, 0);
  });

  it("counts a result arriving after its start was read, and does not replay acknowledged activity", () => {
    const pending = [started(1)];
    const completed = [...pending, finished(2)];
    const unread = advanceUnread(
      initializeUnread(through(pending)),
      index(completed),
      through(completed),
    );
    assert.equal(unread.keys.size, 1);

    const read = acknowledgeUnread(unread);
    assert.equal(read.keys.size, 0);
    assert.equal(advanceUnread(read, index(completed), through(completed)).keys.size, 0);
    const later = [...completed, message(3)];
    assert.equal(advanceUnread(read, index(later), through(later)).keys.size, 1);
  });

  it("ignores earlier history and allowance updates even when the initial tail contains only meters", () => {
    const cold = [meter(10)];
    const earlier = [message(1), started(2), finished(3), ...cold];
    const loaded = advanceUnread(initializeUnread(through(cold)), index(earlier), through(earlier));
    assert.equal(loaded.keys.size, 0);

    const meters = [...earlier, meter(11)];
    const unchanged = advanceUnread(loaded, index(meters), through(meters));
    assert.equal(unchanged.keys.size, 0);
    const live = [...meters, message(12)];
    assert.equal(advanceUnread(unchanged, index(live), through(live)).keys.size, 1);
  });

  it("counts the first live activity in an empty Run and keeps parent and child calls distinct", () => {
    const events = [started(1), started(2, child), finished(3), finished(4, child)];
    const unread = advanceUnread(initializeUnread(null), index(events), through(events));
    assert.equal(unread.keys.size, 2);
  });
});

it("rebuilds unread activity across cold pages without losing updates first discovered on an earlier page", () => {
  const read = initializeUnread(TranscriptSequence.make(10));
  const cold = [message(30), meter(31)];
  const tail = advanceUnread(read, index(cold), through(cold));
  const history = [started(12), finished(14), message(15), ...cold];
  const recovered = advanceUnread(tail, index(history), through(history));
  assert.equal(recovered.keys.size, 3);
  const reopened = advanceUnread(
    initializeUnread(recovered.readThrough),
    index(history),
    through(history),
  );
  assert.deepEqual(reopened.keys, recovered.keys);
  const acknowledged = acknowledgeUnread(reopened);
  assert.equal(advanceUnread(acknowledged, index(history), through(history)).keys.size, 0);
});

it.each(["row", "result"] as const)(
  "recovers the previously visible tool input before restoring its %s across a page boundary",
  (surface) => {
    const complete = readingRows(document([started(386), finished(387), message(426)]));
    const saved = complete.find((row) => row.surface === surface && row.sequence === 386);
    assert.isDefined(saved);
    const anchor = ReadingAnchor.make({
      _tag: "Anchor",
      key: saved.key,
      surface,
      sequence: saved.sequence,
      offset: -87,
    });
    const partial = readingRows(document([finished(387), message(426)]));
    assert.deepEqual(locateReadingAnchor(anchor, partial, "available"), { _tag: "Earlier" });
    assert.deepEqual(locateReadingAnchor(anchor, complete, "available"), {
      _tag: "Row",
      row: saved,
      offset: -87,
      fallback: false,
    });
    const surviving = partial.find((row) => row.key === anchor.key && row.surface === "row");
    assert.isDefined(surviving);
    assert.deepEqual(locateReadingAnchor(anchor, partial, "exhausted"), {
      _tag: "Row",
      row: surviving,
      offset: 0,
      fallback: true,
    });
  },
);
