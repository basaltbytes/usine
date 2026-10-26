import { Option, Schema } from "effect";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  SessionStarted,
  SessionFinished,
  HarnessSession,
  HarnessSessionId,
  ParentSession,
  TextOutput,
  ToolStarted,
  ToolFinished,
  type AgentSessionEvent,
} from "@usine/core/agent/session";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { SessionEvent } from "@usine/core/attempt/channel";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { SshDestination, SshPort, WorkerName } from "@usine/core/worker";
import { TranscriptSequence } from "@usine/engine/transcript";
import {
  AgentFailureView,
  AttemptView,
  FailedAttemptView,
  FailedTranscriptView,
  LocalWorkerAccess,
  RunDetailView,
  RunGitHubChangesView,
  RunView,
  SshWorkerAccess,
  TranscriptEventView,
  TranscriptPageCursor,
  WorkerAccess,
} from "@usine/orchestrator/operator";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { RunWorkspace } from "../src/run-page/workspace.tsx";
import { ReaderBookmark, readerMemory } from "../src/run-transcript/reader/memory.ts";
import "../src/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    githubChangesResponse: (body: string) => Promise<void>;
  }
}

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
const liveAttempt = new AttemptView({
  id: attemptId,
  number: AttemptNumber.make(1),
  worker: WorkerName.make("local"),
  workerAccess: new LocalWorkerAccess(),
  brain: parent.brain,
  task: AttemptTask.make("Read the conversation"),
  agent: parent.agent,
  operatorIntervened: false,
  startedAt: new Date(Date.UTC(2026, 8, 6, 12, 0, 0)).toISOString(),
  outcome: null,
  endedAt: null,
  salvage: null,
});
const runView = (id: RunId, attempts: ReadonlyArray<AttemptView>) =>
  new RunView({
    id,
    itemKey: ItemKey.make("item"),
    loop: LoopName.make("implement"),
    repository: RepositoryName.make("basaltbytes/usine"),
    agent: parent.agent,
    state: "Running",
    loopPaused: false,
    openedAt: new Date(Date.UTC(2026, 8, 6, 12, 0, 0)).toISOString(),
    closedAt: null,
    task: "Read the conversation",
    attempts,
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
let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const mount = (
  transcript = events,
  id = runId,
  history: {
    earlier: TranscriptPageCursor | undefined;
    loading: boolean;
    load: () => void;
  } = { earlier: undefined, loading: false, load: () => {} },
  attempts: ReadonlyArray<AttemptView> = [],
) => {
  const cursors = history.earlier === undefined ? [] : [history.earlier];
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RunWorkspace
          key={id}
          detail={
            new RunDetailView({
              run: runView(id, attempts),
              eventDedupKey: '["implement","basaltbytes/usine",7]',
              eventPayload: { tick: "scheduled" },
              transcript,
              sessionState: [],
              earlierTranscript: cursors,
            })
          }
          history={{ cursors, loading: history.loading, error: null, load: history.load }}
        />
      </QueryClientProvider>,
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
const atLatest = () => viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop;
const bookmark = () => readerMemory(() => localStorage).read(runId, Date.now());
const burst = (calls: number) =>
  page.getByRole("button", { name: new RegExp(`${calls} tool calls?$`, "u") });
// The reader scrolls to the latest row after mounting, and an opened burst panel expands with a CSS
// transition; positions read before either ends are not stable.
const ownScrollEnded = () =>
  expect.poll(() => viewport().hasAttribute("data-autoscrolling")).toBe(false);
const openBurst = async (calls: number) => {
  await ownScrollEnded();
  await burst(calls).click();
  await expect
    .poll(() => {
      const panel = document.getElementById(
        burst(calls).element().getAttribute("aria-controls") ?? "",
      );
      return (
        panel !== null &&
        !panel.hasAttribute("data-starting-style") &&
        panel.getAnimations().length === 0
      );
    })
    .toBe(true);
};

beforeEach(async () => {
  await page.viewport(1280, 800);
  // Without a response, the GitHub changes request fails and its retry a second later adds an error
  // line above the reader, which shrinks it mid-test.
  await commands.githubChangesResponse(
    JSON.stringify(
      Schema.encodeSync(RunGitHubChangesView)(new RunGitHubChangesView({ attempts: [] })),
    ),
  );
  localStorage.clear();
  queryClient = new QueryClient();
  host = document.createElement("div");
  host.style.cssText = "height:600px;width:1100px;display:flex;flex-direction:column";
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  queryClient.clear();
  vi.restoreAllMocks();
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
  await expect.poll(atLatest).toBeLessThan(9);
  close();
  expect(bookmark()?.position._tag).toBe("Latest");
  mount([...events, message(46), message(47)]);
  await expect.poll(atLatest).toBeLessThan(9);
});

it("keeps inspected burst and tool disclosures isolated by Run across remounts", async () => {
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
  await openBurst(2);
  await page.getByRole("button", { name: /first.ts.*Completed/ }).click();
  await expect.element(page.getByText("first contents", { exact: true })).toBeVisible();
  close();
  mount(tools, RunId.make("other-run"));
  await expect.element(burst(2)).toHaveAttribute("aria-expanded", "false");
  await expect.element(page.getByText("first contents", { exact: true })).not.toBeInTheDocument();
  close();
  mount(tools);
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

it("keeps a pending bookmark intact when the page closes before history is available", async () => {
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
  await expect.element(page.getByText(/Saved place not in the loaded history/)).toBeVisible();
  expect(first).toBe(80);
  await expect
    .element(page.getByRole("button", { name: "21 new updates", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "21 new updates", exact: true }).click();
  await expect.poll(atLatest).toBeLessThan(9);
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

it("restores inside a child tool result after its burst gains an earlier member", async () => {
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
  await openBurst(2);
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
  await openBurst(1);
  await page.getByRole("button", { name: /latest.ts.*Running/ }).click();
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await page.getByRole("button", { name: /latest.ts.*Running/ }).click();
  mount([...initial, message(47)]);
  await expect.poll(atLatest).toBeLessThan(9);
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
    // The Agent continues after the failed read, so it is a recovered tool failure.
    message(48),
  ];
  mount([...events.slice(30), ...error], runId, {
    earlier: new TranscriptPageCursor({ attemptId, before: TranscriptSequence.make(31) }),
    loading: true,
    load: () => {},
  });
  await page.getByRole("button", { name: "Next recovered tool failure", exact: true }).click();
  const errorButton = page.getByRole("button", { name: /error.ts.*Error/ });
  await expect.element(errorButton).toHaveAttribute("aria-expanded", "true");
  const errorOffset = () =>
    errorButton.element().getBoundingClientRect().top - viewport().getBoundingClientRect().top;
  await expect.poll(errorOffset).toBeLessThan(24);
  await expect
    .element(page.getByRole("button", { name: "2 new updates", exact: true }))
    .toBeVisible();
  const previousOffset = errorOffset();
  mount([...events, ...error]);
  await expect.poll(errorOffset).toBeCloseTo(previousOffset, 0);
  await expect
    .element(page.getByRole("button", { name: "2 new updates", exact: true }))
    .toBeVisible();
});

it("keeps failed commands inside their burst and reopens inspected errors through a collapsed burst", async () => {
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
  const group = page.getByRole("button", { name: /Ran 3 commands, 1 failed/ });
  await expect.element(group).toHaveAttribute("aria-expanded", "false");
  const failed = page.getByRole("button", { name: /node check.js.*Error/ });
  await expect.element(failed).not.toBeInTheDocument();

  // The Agent continued after the failed command, so it counts as recovered, not as an error.
  await expect.element(page.getByRole("button", { name: "Next error" })).not.toBeInTheDocument();
  const next = page.getByRole("button", { name: "Next recovered tool failure", exact: true });
  await next.click();
  await expect.element(group).toHaveAttribute("aria-expanded", "true");
  await expect.element(failed).toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("Validation failed", { exact: true })).toBeVisible();

  await group.click();
  await expect.element(failed).not.toBeInTheDocument();
  await next.click();
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
    await openBurst(1);
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
  await openBurst(1);
  const tool = page.getByRole("button", { name: /paused.ts.*Running/ });
  await tool.click();
  await tool.click();
  await expect
    .element(page.getByText("Waiting for a result…", { exact: true }))
    .not.toBeInTheDocument();
  // The current activity line is below the call; the test sets scrollTop instead of scrolling.
  viewport().scrollTop = viewport().scrollHeight;
  await expect.poll(atLatest).toBeLessThan(9);
  viewport().focus();
  await userEvent.keyboard(" ");
  mount([...initial, message(47)]);
  await expect.poll(atLatest).toBeLessThan(9);
  close();
  expect(bookmark()?.position._tag).toBe("Latest");
});

const swipe = (element: Element, fromY: number, toY: number) => {
  const touches = (clientY: number) => [
    new Touch({ identifier: 1, target: element, clientX: 300, clientY }),
  ];
  element.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: touches(fromY) }));
  element.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: touches(toY) }));
  element.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
};

it.each(["End", "Space", "ArrowDown", "PageDown", "wheel", "swipe"] as const)(
  "keeps following when %s at the latest row scrolls nothing",
  async (input) => {
    mount();
    await expect.poll(atLatest).toBeLessThan(9);
    await ownScrollEnded();
    if (input === "wheel") await userEvent.wheel(viewport(), { delta: { y: 100 } });
    else if (input === "swipe") swipe(viewport(), 400, 300);
    else {
      viewport().focus();
      await userEvent.keyboard(input === "Space" ? " " : `{${input}}`);
    }
    mount([...events, message(46)]);
    await expect.poll(atLatest).toBeLessThan(9);
  },
);

const longRead = [
  record(
    46,
    new ToolStarted({ session: parent, callId: "long", tool: "read", input: { path: "long.ts" } }),
  ),
  record(
    47,
    new ToolFinished({
      session: parent,
      callId: "long",
      tool: "read",
      output: Array.from({ length: 100 }, (_, line) => `source line ${line}`).join("\n"),
      isError: false,
    }),
  ),
];
// Opening the read pauses the reader, like any inspection.
const openLongOutput = async () => {
  // Tall enough to show the whole output at the latest row, so hovering it does not scroll.
  host.style.height = "800px";
  mount([...events, ...longRead]);
  await openBurst(1);
  await page.getByRole("button", { name: /long.ts.*Completed/ }).click();
  const result = host.querySelector(
    `[data-transcript-id='${JSON.stringify([attemptId, parent.id, "long"])}:result'] pre`,
  );
  if (result?.parentElement == null) throw new Error("Missing tool output");
  return result.parentElement;
};
const followLongOutput = async () => {
  const output = await openLongOutput();
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(atLatest).toBeLessThan(9);
  await ownScrollEnded();
  return output;
};

it.each(["wheel", "swipe"] as const)(
  "keeps following when a %s scrolls a tool output at the latest row",
  async (input) => {
    const output = await followLongOutput();
    const end = output.scrollHeight - output.clientHeight;
    output.scrollTop = end;
    if (input === "wheel") {
      await userEvent.wheel(output, { delta: { y: -100 } });
      await expect.poll(() => output.scrollTop).toBeLessThan(end);
    } else swipe(output, 300, 400);
    mount([...events, ...longRead, message(48)]);
    await expect.poll(atLatest).toBeLessThan(9);
  },
);

it("stops following when a wheel turn up scrolls the conversation at the latest row", async () => {
  await followLongOutput();
  await userEvent.wheel(page.getByRole("status", { name: "Current activity" }), {
    delta: { y: -100 },
  });
  await expect.poll(atLatest).toBeGreaterThan(50);
  mount([...events, ...longRead, message(48)]);
  await expect
    .element(page.getByRole("button", { name: "1 new update", exact: true }))
    .toBeVisible();
});

it("resumes following when a wheel turn past a tool output's end reaches the latest row", async () => {
  const output = await openLongOutput();
  output.scrollTop = output.scrollHeight;
  await userEvent.wheel(output, { delta: { y: 800 } });
  await expect.poll(atLatest).toBeLessThan(9);
  mount([...events, ...longRead, message(48)]);
  await expect.poll(atLatest).toBeLessThan(9);
});

it("scrolls the reader to a checkpoint chosen in the outline and stops following", async () => {
  mount(events, runId, undefined, [liveAttempt]);
  await expect.poll(atLatest).toBeLessThan(9);
  const outline = page.getByRole("navigation", { name: "Run outline" });
  await expect
    .element(outline.getByRole("button", { name: "Attempt 1, running" }))
    .toHaveAttribute("aria-expanded", "true");
  await outline.getByRole("button", { name: "Parent, 45 messages" }).click();
  await outline.getByRole("button", { name: "Message 12", exact: true }).click();
  // The reader keeps its top padding above the row it jumps to.
  await expect.poll(() => offset(12)).toBeGreaterThanOrEqual(0);
  await expect.poll(() => offset(12)).toBeLessThan(24);
  const landed = offset(12);
  mount([...events, message(46)], runId, undefined, [liveAttempt]);
  await expect.poll(() => Math.abs(offset(12) - landed)).toBeLessThan(2);
  await expect
    .element(page.getByRole("button", { name: "1 new update", exact: true }))
    .toBeVisible();
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
  expect(bookmark()?.position).toMatchObject({ _tag: "Anchor", key: "event:12" });
});

it("shows the Task and the Event in the reader and returns to the same reading place", async () => {
  mount(events, runId, undefined, [liveAttempt]);
  await moveTo(20, 10);
  const outline = page.getByRole("navigation", { name: "Run outline" });
  await outline.getByRole("button", { name: /^Task/ }).click();
  await expect
    .element(page.getByRole("article", { name: "Task" }).getByText("Read the conversation"))
    .toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Run conversation" }))
    .not.toBeInTheDocument();
  await outline.getByRole("button", { name: /^Event/ }).click();
  await page.getByRole("button", { name: "Raw details", exact: true }).click();
  await expect.element(page.getByText('"tick": "scheduled"', { exact: false })).toBeVisible();
  await outline.getByRole("button", { name: "Attempt 1, running" }).click();
  await expect.element(page.getByRole("region", { name: "Run conversation" })).toBeVisible();
  await expect.poll(() => offset(20)).toBeCloseTo(-10, 0);
});

it("addresses the composer to the parent until a live child is chosen in the outline", async () => {
  const child = new ChildSession({
    id: AgentSessionId.make("child"),
    parentId: parent.id,
    agent: AgentName.make("reviewer"),
    brain: parent.brain,
  });
  mount(
    [...events, record(46, new TextOutput({ session: child, text: "Child is reviewing." }))],
    runId,
    undefined,
    [liveAttempt],
  );
  await expect.element(page.getByLabelText("Message the parent")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Run outline" })
    .getByRole("button", { name: /^reviewer(?!,)/ })
    .click();
  await expect.element(page.getByLabelText("Message this child")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Release child" })).toBeVisible();
});

const usineWorker = SshDestination.make("usine-worker-1");
const sameLogin = "Same harness login as the attempt. The worktree is removed at attempt cleanup";
const resumeCases: ReadonlyArray<{
  readonly worker: string;
  readonly harness: "claude" | "codex";
  readonly access: WorkerAccess | null;
  readonly facts: ReadonlyArray<string>;
  readonly command: string;
  readonly note?: string;
  /** The child's model requests used the gateway's credential, with Codex in the attempt's own home. */
  readonly gateway?: { readonly home: string };
}> = [
  {
    worker: "local",
    harness: "claude",
    access: new LocalWorkerAccess(),
    facts: ["Worktree /worker/Philippe's repo"],
    command: String.raw`cd -- '/worker/Philippe'\''s repo' && claude --resume 'native-session'`,
  },
  {
    worker: "usine-worker-1",
    harness: "codex",
    access: new SshWorkerAccess({ destination: usineWorker, port: null }),
    facts: ["Worktree /worker/Philippe's repo on usine-worker-1"],
    command: String.raw`ssh -t usine-worker-1 'cd -- '\''/worker/Philippe'\''\'\'''\''s repo'\'' && codex resume -- '\''native-session'\'''`,
  },
  {
    worker: "usine-worker-1",
    harness: "codex",
    access: new SshWorkerAccess({ destination: usineWorker, port: null }),
    gateway: { home: "/worker/codex/attempt-1" },
    facts: ["Worktree /worker/Philippe's repo on usine-worker-1"],
    command: String.raw`ssh -t usine-worker-1 'cd -- '\''/worker/Philippe'\''\'\'''\''s repo'\'' && CODEX_HOME='\''/worker/codex/attempt-1'\'' codex resume -- '\''native-session'\'''`,
    note: "The gateway credential isn't available from your shell. The worktree is removed at attempt cleanup",
  },
  {
    worker: "usine-worker-1",
    harness: "claude",
    access: new SshWorkerAccess({ destination: usineWorker, port: SshPort.make(2222) }),
    facts: ["Worktree /worker/Philippe's repo on usine-worker-1"],
    command: String.raw`ssh -t -p 2222 usine-worker-1 'cd -- '\''/worker/Philippe'\''\'\'''\''s repo'\'' && claude --resume '\''native-session'\'''`,
  },
  {
    worker: "retired-worker",
    harness: "claude",
    access: null,
    facts: [
      "Worktree /worker/Philippe's repo",
      "Worker retired-worker is no longer declared in usine.yaml",
    ],
    command: String.raw`cd -- '/worker/Philippe'\''s repo' && claude --resume 'native-session'`,
  },
  {
    worker: "hz-pool",
    harness: "claude",
    access: Schema.decodeUnknownSync(WorkerAccess)({ _tag: "Provisioned", provider: "hetzner" }),
    facts: ["Worktree /worker/Philippe's repo on hz-pool"],
    command: String.raw`cd -- '/worker/Philippe'\''s repo' && claude --resume 'native-session'`,
    note: "Run it on the attempt's Hetzner machine, which is deleted with the attempt",
  },
];

it.each(resumeCases)(
  "gives a finished $harness child on $worker one copyable command for the operator's terminal",
  async ({ worker, harness, access, facts, command, note = sameLogin, gateway }) => {
    const child = new ChildSession({
      id: AgentSessionId.make("saved-child"),
      parentId: parent.id,
      agent: AgentName.make("reviewer"),
      brain: new BrainSpec({ harness, model: ModelId.make("test-model"), effort: "high" }),
      gatewayCredential: gateway === undefined ? Option.none() : Option.some("subscription"),
    });
    const saved = new HarnessSession({
      id: HarnessSessionId.make("native-session"),
      cwd: "/worker/Philippe's repo",
      home: Option.fromNullishOr(gateway?.home),
    });
    const copied: Array<string> = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      copied.push(text);
    });
    mount(
      [
        record(1, new SessionStarted({ session: child, harnessSession: Option.some(saved) })),
        record(2, new SessionFinished({ session: child })),
      ],
      runId,
      undefined,
      [new AttemptView({ ...liveAttempt, worker: WorkerName.make(worker), workerAccess: access })],
    );
    await page.getByRole("button", { name: "Resume details for reviewer" }).click();
    await expect.element(page.getByText("Session native-session", { exact: true })).toBeVisible();
    for (const fact of facts) {
      await expect.element(page.getByText(fact, { exact: true })).toBeVisible();
    }
    await expect.element(page.getByText("Resume this session", { exact: true })).toBeVisible();
    await expect.element(page.getByText(note, { exact: true })).toBeVisible();
    // The command wraps in the popover instead of scrolling sideways.
    const code = page.getByRole("dialog").element().querySelector("pre");
    expect(code?.textContent).toBe(command);
    expect(code?.scrollWidth).toBeLessThanOrEqual(code?.clientWidth ?? 0);
    await page.getByRole("button", { name: "Copy command" }).click();
    await expect.poll(() => copied).toEqual([command]);
  },
);

const failure = new AgentFailureView({ message: "The first Attempt was blocked." });
const firstAttempt = new AttemptView({
  ...liveAttempt,
  id: AttemptId.make("first"),
  outcome: new FailedAttemptView({ failure }),
  endedAt: new Date(Date.UTC(2026, 8, 6, 11, 50, 0)).toISOString(),
});
const retried = new AttemptView({ ...liveAttempt, number: AttemptNumber.make(2) });
const earlierAttempt = Array.from({ length: 20 }, (_, index) => {
  const event = message(index + 1);
  return new TranscriptEventView({ ...event, attemptId: firstAttempt.id });
});
const failedEnvelope = new TranscriptEventView({
  sequence: TranscriptSequence.make(21),
  attemptId: firstAttempt.id,
  receivedAt: new Date(Date.UTC(2026, 8, 6, 12, 0, 21)).toISOString(),
  direction: "outbound",
  payload: new FailedTranscriptView({ failure }),
});
const twoAttempts = [
  ...earlierAttempt,
  failedEnvelope,
  ...Array.from({ length: 25 }, (_, index) => message(index + 22)),
];

it("opens the outline on the Attempt being read and marks its checkpoint without moving the reader", async () => {
  mount(twoAttempts, runId, undefined, [firstAttempt, retried]);
  await expect.poll(atLatest).toBeLessThan(9);
  const outline = page.getByRole("navigation", { name: "Run outline" });
  const first = outline.getByRole("button", { name: "Attempt 1, failed" });
  const second = outline.getByRole("button", { name: "Attempt 2, running" });
  await expect.element(second).toHaveAttribute("aria-expanded", "true");
  await expect.element(first).toHaveAttribute("aria-expanded", "false");
  await moveTo(8, 0);
  await expect.element(first).toHaveAttribute("aria-expanded", "true");
  await expect.element(second).toHaveAttribute("aria-expanded", "false");
  // A closed fold has the current-location mark of the turn being read; when open, the turn has it.
  const firstTurns = outline.getByRole("button", { name: "Parent, 20 messages" });
  await expect.element(firstTurns).toHaveAttribute("aria-current", "location");
  await firstTurns.click();
  await expect
    .element(outline.getByRole("button", { name: "Message 8", exact: true }))
    .toHaveAttribute("aria-current", "location");
  await expect.element(firstTurns).not.toHaveAttribute("aria-current");
  await expect.poll(() => offset(8)).toBeCloseTo(0, 0);
  await moveTo(40, 0);
  await expect.element(second).toHaveAttribute("aria-expanded", "true");
  await expect
    .element(outline.getByRole("button", { name: "Parent, 25 messages" }))
    .toHaveAttribute("aria-current", "location");
});

it("opens a finished Run on a narrow screen at its outcome's own line", async () => {
  await page.viewport(390, 844);
  mount([...earlierAttempt, failedEnvelope], runId, undefined, [firstAttempt]);
  // The outcome row; on a narrow screen its time line is above the note.
  const outcome = () =>
    [...host.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (element) => element.dataset.messageId === "event:21",
    );
  await expect
    .poll(() => {
      const element = outcome();
      return element === undefined
        ? Number.NaN
        : element.getBoundingClientRect().top - viewport().getBoundingClientRect().top;
    })
    .toBeLessThan(24);
  expect(
    (outcome()?.getBoundingClientRect().top ?? -1) - viewport().getBoundingClientRect().top,
  ).toBeGreaterThanOrEqual(0);
  await expect
    .element(
      page
        .getByRole("region", { name: "Run conversation" })
        .getByText("The first Attempt was blocked."),
    )
    .toBeVisible();
});

it("shows that a Pi child has no saved harness session to resume", async () => {
  const child = new ChildSession({
    id: AgentSessionId.make("pi-child"),
    parentId: parent.id,
    agent: AgentName.make("reviewer"),
    brain: new BrainSpec({ harness: "pi", model: ModelId.make("test-model"), effort: "high" }),
  });
  mount(
    [
      record(1, new SessionStarted({ session: child })),
      record(2, new SessionFinished({ session: child })),
    ],
    runId,
    undefined,
    [liveAttempt],
  );
  await page.getByRole("button", { name: "Resume details for reviewer" }).click();
  await expect.element(page.getByText("No saved harness session")).toBeVisible();
  expect(document.body.textContent).not.toContain("Resume this session");
});
