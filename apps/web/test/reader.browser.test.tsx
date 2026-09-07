import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  TextOutput,
  ToolStarted,
  ToolFinished,
  type AgentSessionEvent,
} from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { SessionEvent } from "@usine/core/attempt/channel";
import { RunId } from "@usine/core/run";
import { TranscriptSequence } from "@usine/engine/transcript";
import { TranscriptEventView, TranscriptPageCursor } from "@usine/orchestrator/operator";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Conversation } from "../src/run-transcript/conversation.tsx";
import { ReaderBookmark, readerMemory } from "../src/run-transcript/reader/memory.ts";
import "../src/index.css";

const runId = RunId.make("reader-test");
const attemptId = AttemptId.make("attempt");
const parent = new ParentSession({
  id: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain: new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "high" }),
});
const record = (sequence: number, event: AgentSessionEvent) =>
  new TranscriptEventView({
    sequence: TranscriptSequence.make(sequence),
    attemptId,
    receivedAt: new Date(Date.UTC(2026, 8, 6, 12, 0, sequence)).toISOString(),
    direction: "outbound",
    payload: new SessionEvent({ event }),
  });
const message = (sequence: number) =>
  record(
    sequence,
    new TextOutput({
      session: parent,
      text: `Message ${sequence}\n\nConversation content for reading position.\n\nAnother paragraph with enough height to scroll.`,
    }),
  );
const events = Array.from({ length: 45 }, (_, index) => message(index + 1));
let host: HTMLDivElement;
let root: Root;
const mount = (
  transcript = events,
  id = runId,
  history: {
    earlier: TranscriptPageCursor | undefined;
    loading: boolean;
    load: () => void;
  } = { earlier: undefined, loading: false, load: () => {} },
) => {
  flushSync(() =>
    root.render(
      <Conversation
        key={id}
        runId={id}
        events={transcript}
        attempts={[]}
        earlier={history.earlier}
        loadingEarlier={history.loading}
        earlierError={null}
        loadEarlier={history.load}
        state="Running"
        active
      />,
    ),
  );
};
const close = () => flushSync(() => root.render(null));
const viewport = () => page.getByRole("region", { name: "Run conversation" }).element();
const row = (sequence: number) => {
  const element = host.querySelector<HTMLElement>(`[data-transcript-id="event:${sequence}"]`);
  if (element === null) throw new Error(`Missing message ${sequence}`);
  return element;
};
const offset = (sequence: number) =>
  row(sequence).getBoundingClientRect().top - viewport().getBoundingClientRect().top;
const moveTo = async (sequence: number, within = 45) => {
  const element = viewport();
  element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
  element.scrollTop += offset(sequence) + within;
  element.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.poll(() => offset(sequence)).toBeCloseTo(-within, 0);
};
const bookmark = () => readerMemory(() => localStorage).read(runId, Date.now());

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  host.style.cssText = "height:600px;width:760px;display:flex;flex-direction:column";
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

it("reopens and cold-loads the same row offset without consuming activity received while closed", async () => {
  mount();
  await expect.poll(() => viewport().scrollTop).toBeGreaterThan(1000);
  await moveTo(12);
  close();
  expect(bookmark()?.position._tag).toBe("Anchor");
  const tail = [...events.slice(30), message(46)];
  mount(tail, runId, {
    earlier: new TranscriptPageCursor({ attemptId, before: TranscriptSequence.make(31) }),
    loading: false,
    load: () => queueMicrotask(() => mount([...events, message(46)])),
  });
  await expect.poll(() => offset(12)).toBeCloseTo(-45, 0);
  await expect
    .element(page.getByRole("button", { name: "1 new update", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "1 new update", exact: true }).click();
  await expect
    .poll(() => viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop)
    .toBeLessThan(9);
  close();
  expect(bookmark()?.position._tag).toBe("Latest");
  mount([...events, message(46), message(47)]);
  await expect
    .poll(() => viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop)
    .toBeLessThan(9);
});

it("keeps filters and inspected group/tool disclosures isolated by Run across remounts", async () => {
  const tools = [
    record(
      1,
      new ToolStarted({ session: parent, callId: "a", tool: "read", input: { path: "first.ts" } }),
    ),
    record(
      2,
      new ToolFinished({
        session: parent,
        callId: "a",
        tool: "read",
        output: "first contents",
        isError: false,
      }),
    ),
    record(
      3,
      new ToolStarted({ session: parent, callId: "b", tool: "read", input: { path: "second.ts" } }),
    ),
    record(
      4,
      new ToolFinished({
        session: parent,
        callId: "b",
        tool: "read",
        output: "second contents",
        isError: false,
      }),
    ),
    ...events.slice(4),
  ];
  mount(tools);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: /completed tools/i }).click();
  await page.getByRole("button", { name: /first.ts.*Completed/ }).click();
  await expect.element(page.getByText("first contents", { exact: true })).toBeVisible();
  close();
  mount(tools, RunId.make("other-run"));
  await expect
    .element(page.getByRole("button", { name: "Everything", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  close();
  mount(tools);
  await expect
    .element(page.getByRole("button", { name: "Tools", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(page.getByText("first contents", { exact: true })).toBeVisible();
});

it("lets scrolling cancel a delayed restoration and preserves that choice when the page arrives", async () => {
  mount();
  await expect.poll(() => viewport().scrollTop).toBeGreaterThan(1000);
  await moveTo(12);
  close();
  let requested = false;
  mount(events.slice(30), runId, {
    earlier: new TranscriptPageCursor({ attemptId, before: TranscriptSequence.make(31) }),
    loading: false,
    load: () => {
      requested = true;
    },
  });
  await expect.poll(() => requested).toBe(true);
  await moveTo(37, 30);
  mount(events);
  await expect.poll(() => offset(37)).toBeCloseTo(-30, 0);
  close();
  mount(events);
  await expect.poll(() => offset(37)).toBeCloseTo(-30, 0);
});

it("keeps a pending bookmark intact when the drawer closes before history is available", async () => {
  mount();
  await expect.poll(() => viewport().scrollTop).toBeGreaterThan(1000);
  await moveTo(12);
  close();
  mount(events.slice(30), runId, {
    earlier: new TranscriptPageCursor({ attemptId, before: TranscriptSequence.make(31) }),
    loading: true,
    load: () => {},
  });
  close();
  mount(events);
  await expect.poll(() => offset(12)).toBeCloseTo(-45, 0);
});

it("bounds missing-row recovery and leaves unseen activity unread at its visible fallback", async () => {
  readerMemory(() => localStorage).write(
    runId,
    ReaderBookmark.make({
      filter: "all",
      disclosures: [],
      position: {
        _tag: "Anchor",
        key: "event:1",
        sequence: TranscriptSequence.make(1),
        surface: "row",
        offset: 0,
      },
      readThrough: TranscriptSequence.make(45),
    }),
    Date.now(),
  );
  let first = 100;
  const loaded = [message(first)];
  const load = () =>
    queueMicrotask(() => {
      first -= 1;
      loaded.unshift(message(first));
      show();
    });
  const show = () =>
    mount([...loaded], runId, {
      earlier: new TranscriptPageCursor({ attemptId, before: TranscriptSequence.make(first) }),
      loading: false,
      load,
    });
  show();
  await expect.element(page.getByText(/saved place is outside the loaded history/)).toBeVisible();
  expect(first).toBe(80);
  await expect
    .element(page.getByRole("button", { name: "21 new updates", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "21 new updates", exact: true }).click();
  await expect
    .poll(() => viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop)
    .toBeLessThan(9);
});

it("flushes the current reading place on page exit and keeps newer results unread after refresh", async () => {
  const started = record(
    1,
    new ToolStarted({
      session: parent,
      callId: "pending",
      tool: "read",
      input: { path: "source.ts" },
    }),
  );
  const initial = [started, ...events.slice(1)];
  mount(initial);
  await expect.poll(() => viewport().scrollTop).toBeGreaterThan(1000);
  await moveTo(14, 32);
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
  close();
  const completed = record(
    46,
    new ToolFinished({
      session: parent,
      callId: "pending",
      tool: "read",
      output: "new result",
      isError: false,
    }),
  );
  mount([...initial, completed]);
  await expect.poll(() => offset(14)).toBeCloseTo(-32, 0);
  await expect
    .element(page.getByRole("button", { name: "1 new update", exact: true }))
    .toBeVisible();
  mount([...initial, completed, message(47)]);
  await expect.poll(() => offset(14)).toBeCloseTo(-32, 0);
  await expect
    .element(page.getByRole("button", { name: "2 new updates", exact: true }))
    .toBeVisible();
});

it("restores inside a child tool result after its completed group gains an earlier member", async () => {
  const child = new ChildSession({
    id: AgentSessionId.make("child"),
    parentId: parent.id,
    agent: AgentName.make("reviewer"),
    brain: parent.brain,
  });
  const tools = [
    record(
      16,
      new ToolStarted({
        session: child,
        callId: "child-a",
        tool: "read",
        input: { path: "child.ts" },
      }),
    ),
    record(
      17,
      new ToolFinished({
        session: child,
        callId: "child-a",
        tool: "read",
        output: Array.from({ length: 100 }, (_, i) => `source line ${i}`).join("\n"),
        isError: false,
      }),
    ),
    record(
      18,
      new ToolStarted({
        session: child,
        callId: "child-b",
        tool: "read",
        input: { path: "other.ts" },
      }),
    ),
    record(
      19,
      new ToolFinished({
        session: child,
        callId: "child-b",
        tool: "read",
        output: "other source",
        isError: false,
      }),
    ),
  ];
  const initial = [...events.slice(0, 15), ...tools, ...events.slice(19)];
  mount(initial);
  await page.getByRole("button", { name: /reviewer activity/ }).click();
  await page.getByRole("button", { name: /completed tools/i }).click();
  await page.getByRole("button", { name: /child.ts.*Completed/ }).click();
  const output = () => {
    const resultId = `${JSON.stringify([attemptId, child.id, "child-a"])}:result`;
    const result = [...host.querySelectorAll<HTMLElement>("[data-transcript-id]")].find(
      (element) => element.dataset.transcriptId === resultId,
    );
    if (result === undefined) throw new Error("Missing child result");
    return result;
  };
  const resultOffset = () =>
    output().getBoundingClientRect().top - viewport().getBoundingClientRect().top;
  viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
  viewport().scrollTop += resultOffset() + 180;
  viewport().dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.poll(resultOffset).toBeCloseTo(-180, 0);
  const previousOffset = resultOffset();
  close();
  const older = record(
    15,
    new ToolFinished({
      session: child,
      callId: "earlier",
      tool: "read",
      output: "earlier source",
      isError: false,
    }),
  );
  mount([...events.slice(0, 14), older, ...tools, ...events.slice(19)]);
  await expect.poll(() => Math.abs(resultOffset() - previousOffset)).toBeLessThan(2);
});

it("continues following when an inspected tool is collapsed after jumping to latest", async () => {
  const started = record(
    46,
    new ToolStarted({
      session: parent,
      callId: "latest",
      tool: "read",
      input: { path: "latest.ts" },
    }),
  );
  const initial = [...events, started];
  mount(initial);
  await page.getByRole("button", { name: /latest.ts.*Running/ }).click();
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await page.getByRole("button", { name: /latest.ts.*Running/ }).click();
  mount([...initial, message(47)]);
  await expect
    .poll(() => viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop)
    .toBeLessThan(9);
  close();
  expect(bookmark()?.position._tag).toBe("Latest");
});

it("lets keyboard navigation supersede an in-flight history restore", async () => {
  mount();
  await expect.poll(() => viewport().scrollTop).toBeGreaterThan(1000);
  await moveTo(12);
  close();
  let requested = false;
  mount(events.slice(30), runId, {
    earlier: new TranscriptPageCursor({ attemptId, before: TranscriptSequence.make(31) }),
    loading: false,
    load: () => {
      requested = true;
    },
  });
  await expect.poll(() => requested).toBe(true);
  viewport().focus();
  await userEvent.keyboard("{Home}");
  const previousOffset = offset(31);
  mount(events);
  await expect.poll(() => offset(31)).toBeCloseTo(previousOffset, 0);
});

it("reveals an error instead of the pending saved place and preserves unread activity after history arrives", async () => {
  mount();
  await expect.poll(() => viewport().scrollTop).toBeGreaterThan(1000);
  await moveTo(12);
  close();
  const error = [
    record(
      46,
      new ToolStarted({
        session: parent,
        callId: "error",
        tool: "read",
        input: { path: "error.ts" },
      }),
    ),
    record(
      47,
      new ToolFinished({
        session: parent,
        callId: "error",
        tool: "read",
        output: "Could not read source",
        isError: true,
      }),
    ),
  ];
  mount([...events.slice(30), ...error], runId, {
    earlier: new TranscriptPageCursor({ attemptId, before: TranscriptSequence.make(31) }),
    loading: true,
    load: () => {},
  });
  await page.getByRole("button", { name: "Next error", exact: true }).click();
  const errorButton = page.getByRole("button", { name: /error.ts.*Error/ });
  await expect.element(errorButton).toHaveAttribute("aria-expanded", "true");
  const errorOffset = () =>
    errorButton.element().getBoundingClientRect().top - viewport().getBoundingClientRect().top;
  await expect.poll(errorOffset).toBeLessThan(24);
  await expect
    .element(page.getByRole("button", { name: "1 new update", exact: true }))
    .toBeVisible();
  const previousOffset = errorOffset();
  mount([...events, ...error]);
  await expect.poll(errorOffset).toBeCloseTo(previousOffset, 0);
  await expect
    .element(page.getByRole("button", { name: "1 new update", exact: true }))
    .toBeVisible();
});

it("keeps failed commands inside their group and reopens inspected errors through collapsed child activity", async () => {
  const child = new ChildSession({
    id: AgentSessionId.make("child"),
    parentId: parent.id,
    agent: AgentName.make("reviewer"),
    brain: parent.brain,
  });
  const tools = ["git status", "node check.js", "git diff"].flatMap((command, index) => [
    record(
      16 + index * 2,
      new ToolStarted({ session: child, callId: command, tool: "Bash", input: { command } }),
    ),
    record(
      17 + index * 2,
      new ToolFinished({
        session: child,
        callId: command,
        tool: "Bash",
        output: index === 1 ? "Validation failed" : "Done",
        isError: index === 1,
      }),
    ),
  ]);
  mount([...events.slice(0, 15), ...tools, ...events.slice(21)]);
  const activity = page.getByRole("button", { name: /reviewer activity/ });
  await activity.click();
  const group = page.getByRole("button", { name: /Ran 3 commands.*1 error/ });
  await expect.element(group).toHaveAttribute("aria-expanded", "false");
  const failed = page.getByRole("button", { name: /node check.js.*Error/ });
  await expect.element(failed).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Next error", exact: true }).click();
  await expect.element(group).toHaveAttribute("aria-expanded", "true");
  await expect.element(failed).toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("Validation failed", { exact: true })).toBeVisible();

  await group.click();
  await expect.element(failed).not.toBeInTheDocument();
  await activity.click();
  await page.getByRole("button", { name: "Next error", exact: true }).click();
  await expect.element(group).toHaveAttribute("aria-expanded", "true");
  await expect.element(failed).toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("Validation failed", { exact: true })).toBeVisible();
});

it.each(["pointer", "Space"] as const)(
  "keeps an inspected reader paused after %s collapse and reopening",
  async (activation) => {
    const started = record(
      46,
      new ToolStarted({
        session: parent,
        callId: "paused",
        tool: "read",
        input: { path: "paused.ts" },
      }),
    );
    const initial = [...events, started];
    mount(initial);
    const tool = page.getByRole("button", { name: /paused.ts.*Running/ });
    await tool.click();
    await expect.element(tool).toHaveAttribute("aria-expanded", "true");
    if (activation === "Space") {
      tool.element().focus();
      await userEvent.keyboard(" ");
    } else await tool.click();
    await expect.element(tool).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByText("Waiting for a result…", { exact: true }))
      .not.toBeInTheDocument();
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(bookmark()?.position._tag).toBe("Anchor");
    const previousOffset = offset(45);
    mount([...initial, message(47)]);
    await expect.poll(() => Math.abs(offset(45) - previousOffset)).toBeLessThan(2);
    close();
    expect(bookmark()?.position._tag).toBe("Anchor");
    mount([...initial, message(47), message(48)]);
    await expect.poll(() => Math.abs(offset(45) - previousOffset)).toBeLessThan(2);
    await expect
      .element(page.getByRole("button", { name: "2 new updates", exact: true }))
      .toBeVisible();
  },
);

it("lets Space on the viewport resume following a paused reader at latest", async () => {
  const started = record(
    46,
    new ToolStarted({
      session: parent,
      callId: "paused",
      tool: "read",
      input: { path: "paused.ts" },
    }),
  );
  const initial = [...events, started];
  mount(initial);
  const tool = page.getByRole("button", { name: /paused.ts.*Running/ });
  await tool.click();
  await tool.click();
  await expect
    .element(page.getByText("Waiting for a result…", { exact: true }))
    .not.toBeInTheDocument();
  viewport().focus();
  await userEvent.keyboard(" ");
  mount([...initial, message(47)]);
  await expect
    .poll(() => viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop)
    .toBeLessThan(9);
  close();
  expect(bookmark()?.position._tag).toBe("Latest");
});
