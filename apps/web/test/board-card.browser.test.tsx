import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import {
  CycleBudgetAsk,
  CycleBudgetAskId,
  CycleCount,
  CycleLimit,
  LoopCycleCount,
} from "@usine/core/cycle-budget";
import { EventId } from "@usine/core/event";
import { RunId } from "@usine/core/run";
import { Claimed, CycleBlocked, RunAgainResult } from "@usine/engine/engine";
import { FactoryOverview, type ReadyOverview, type RunView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { RouterProvider } from "@tanstack/react-router";
import { ProjectBoard } from "../src/board/board.tsx";
import { runAgainBlocked, runAgainProgress, timestampLabel } from "../src/operator-copy.ts";
import { overviewQuery } from "../src/overview.ts";
import { boardOverview, boardOverviewReviewing, boardStalled } from "./board-fixture.ts";
import { memoryRouter } from "./memory-router.tsx";
import "../src/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    boardResponses: (overview: string, moveStatus: 200 | 503) => Promise<void>;
    delayRunAgain: () => Promise<void>;
    releaseRunAgain: (
      status: 200 | 409,
      body: string,
    ) => Promise<{ readonly path: string; readonly body: unknown }>;
  }
}

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let opened: Array<RunId>;
let overview: ReadyOverview;
let router: ReturnType<typeof memoryRouter>;

const Board = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  const project = data.projects[0];
  if (project === undefined) return null;
  return (
    <ProjectBoard
      project={project}
      loops={data.loops}
      stalled={boardStalled()}
      disabled={false}
      openRun={(id) => opened.push(id)}
    />
  );
};

const lane = (name: string) => page.getByLabelText(`${name} lane`);
/** Opens the Done lane, which starts folded because it has only closed Items. */
const openDone = () => lane("Done").getByRole("button", { name: "Done 1" }).click();
const actions = (number: number) =>
  page.getByRole("button", { name: `Actions for issue #${number}`, exact: true });
const cardOf = (title: RegExp) => {
  const card = page.getByText(title).element().closest("[data-slot=card]");
  if (!(card instanceof HTMLElement)) throw new Error(`No card titled ${title}`);
  return card;
};
const runOf = (id: string): RunView => {
  const run = overview.projects
    .flatMap(({ board }) => board.lanes)
    .flatMap(({ items }) => items)
    .flatMap(({ runs }) => runs)
    .find((candidate) => candidate.id === id);
  if (run === undefined) throw new Error(`No Run ${id}`);
  return run;
};
/** Returns the card row that contains the Run's state. */
const runLine = (card: HTMLElement, state: string) => {
  const row = page.elementLocator(card).getByText(state, { exact: true }).element().parentElement;
  if (row === null) throw new Error(`No ${state} Run line`);
  return row;
};
/** Returns the open menu's items and the number of separators between its groups. */
const menuContents = async () => {
  const menu = page.getByRole("menu");
  await expect.element(menu).toBeVisible();
  return {
    items: menu
      .getByRole("menuitem")
      .elements()
      .map((item) => item.textContent),
    separators: menu.element().querySelectorAll("[role=separator]").length,
  };
};

beforeEach(async () => {
  await page.viewport(1280, 800);
  overview = boardOverview();
  await commands.boardResponses(JSON.stringify(Schema.encodeSync(FactoryOverview)(overview)), 200);
  opened = [];
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["overview"], overview);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  router = memoryRouter(Board);
  await router.load();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await expect.element(lane("Backlog")).toBeVisible();
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

it("heads each lane with the labels in their GitHub colors and the Item states that route to it", async () => {
  const sources = (name: string) => lane(name).getByRole("list", { name: "Lane sources" });
  const ready = sources("Ready").getByText("ready-for-agent", { exact: true }).element();
  expect(getComputedStyle(ready).borderColor).toBe("rgba(29, 118, 219, 0.4)");
  expect(ready.getAttribute("title")).toBe("An agent may start work");
  expect(
    getComputedStyle(sources("Review").getByText("review", { exact: true }).element()).borderColor,
  ).toBe("rgba(217, 63, 11, 0.4)");
  await openDone();
  const closed = sources("Done").getByText("issue-closed", { exact: true }).element();
  expect(closed.getAttribute("style")).toBeNull();
  expect(closed.classList).toContain("text-muted-foreground");
});

const laneNames = () =>
  [...document.querySelectorAll("section[aria-label$=' lane']")].map((section) =>
    section.getAttribute("aria-label"),
  );

it("puts the lanes that accept moves first, Done and Unmapped last, and folds them into rails", async () => {
  expect(laneNames()).toEqual([
    "Backlog lane",
    "Ready lane",
    "In progress lane",
    "Review lane",
    "Merge lane",
    "Pull requests lane",
    "Done lane",
    "Unmapped lane",
  ]);
  await expect.element(page.getByText("8 lanes, 10 items", { exact: true })).toBeVisible();
  // A pull request that no Loop matches is shown like any other Task.
  await expect.element(lane("Pull requests").getByText(/^Bump vite/u)).toBeVisible();
  const rail = lane("Done").getByRole("button", { name: "Done 1" });
  await expect.element(rail).toHaveAttribute("aria-expanded", "false");
  expect(lane("Done").element().getBoundingClientRect().width).toBeLessThanOrEqual(40);
  await openDone();
  await expect.element(lane("Done").getByText(/^Show the salvage branch/u)).toBeVisible();
  await lane("Done").getByRole("button", { name: "Fold Done", exact: true }).click();
  await expect.element(lane("Done").getByRole("button", { name: "Done 1" })).toBeVisible();
});

it("shows an empty lane at full width with its name, count, and labels", async () => {
  const merge = lane("Merge");
  expect(merge.element().getBoundingClientRect().width).toBeGreaterThan(200);
  await expect.element(merge.getByRole("heading", { name: "Merge 0" })).toBeVisible();
  await expect.element(merge.getByText("ready-to-merge", { exact: true })).toBeVisible();
  await expect.element(merge.getByText("No tasks", { exact: true })).toBeVisible();
});

it("names why a card is stalled, as the overview page does, with the one action that moves it again", async () => {
  const canceled = page.elementLocator(cardOf(/^Cache the label catalog/u));
  const note = canceled.element().querySelector("[data-slot=stall-note]");
  expect(note?.textContent).toMatch(/^implement Canceled \d+h ago, unchanged sinceRun again$/u);
  await expect.element(canceled.getByRole("button", { name: "Run again" })).toBeVisible();
  // The Run line of a waiting Run already shows the Loop.
  const waiting = page.elementLocator(cardOf(/^Retry salvage/u));
  expect(waiting.element().querySelector("[data-slot=stall-note] p")?.textContent).toBe(
    "Waiting for approval",
  );
  await expect.element(waiting.getByRole("button", { name: "Approve" })).toBeVisible();
  // A failed Run shows its failure note and Retry, without a stall note.
  const failed = cardOf(/^Pin GitHub Actions/u);
  expect(failed.querySelector("[data-slot=stall-note]")).toBeNull();
});

it("shows a card's menu button on hover or focus and while its menu is open", async () => {
  const opacity = () => getComputedStyle(actions(12).element()).opacity;
  await userEvent.hover(page.getByRole("heading", { level: 1 }));
  await expect.poll(opacity).toBe("0");
  await userEvent.hover(page.elementLocator(cardOf(/^Document the cycle budget/u)));
  await expect.poll(opacity).toBe("1");
  await userEvent.unhover(page.elementLocator(cardOf(/^Document the cycle budget/u)));
  await expect.poll(opacity).toBe("0");
  actions(12).element().focus();
  await expect.poll(opacity).toBe("1");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menu")).toBeVisible();
  // Focus is now in the menu, not on the card or its button.
  expect(actions(12).element().matches(":focus-within, :hover")).toBe(false);
  await expect.poll(opacity).toBe("1");
});

it("shows the number and kind, a title clamped to two lines, and only labels the lane does not name", async () => {
  const card = cardOf(/^Reader restore test/u);
  expect(card.textContent).toContain("#15");
  await expect
    .element(page.elementLocator(card).getByRole("link", { name: "Issue #15, open", exact: true }))
    .toBeInTheDocument();

  const title = page.getByText(/^Reader restore test/u).element();
  const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight);
  expect(getComputedStyle(title).webkitLineClamp).toBe("2");
  expect(title.scrollHeight).toBeGreaterThan(title.clientHeight);
  expect(title.getBoundingClientRect().height).toBeLessThanOrEqual(2 * lineHeight + 1);

  const labels = (element: HTMLElement) =>
    [...element.querySelectorAll("[data-slot=badge]")].map((badge) => badge.textContent);
  expect(labels(card)).toEqual(["bug", "priority", "ci", "+1"]);
  expect(labels(cardOf(/^Document the cycle budget/u))).toEqual(["docs"]);
});

/** Returns the animation of the state mark at the start of a Run line. */
const markAnimation = (row: HTMLElement) => {
  const mark = row.querySelector("[data-slot=state-mark]");
  if (mark === null) throw new Error("No state mark on the Run line");
  return getComputedStyle(mark).animationName;
};

it("times a running Run from its current Attempt, on one line with a pulsing mark", async () => {
  const running = cardOf(/^Redesign the Board/u);
  expect(running.textContent).toContain("#9#31");
  await expect
    .element(
      page
        .elementLocator(running)
        .getByRole("link", { name: "Pull request #31, open", exact: true }),
    )
    .toBeInTheDocument();
  const ids = running.querySelector("p");
  expect(ids?.getBoundingClientRect().height).toBeLessThanOrEqual(
    Number.parseFloat(getComputedStyle(ids ?? running).lineHeight) + 1,
  );
  const row = runLine(running, "Running");
  expect(row.textContent).toBe("implementRunning6mdeveloper");
  const state = page.elementLocator(running).getByText("Running", { exact: true }).element();
  expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(
    Number.parseFloat(getComputedStyle(state).lineHeight) + 1,
  );
  expect(markAnimation(row)).not.toBe("none");
  const startedAt = runOf("run-redesign").attempts[1]?.startedAt ?? "";
  const time = row.querySelector("time");
  expect(time?.dateTime).toBe(startedAt);
  expect(time?.title).toBe(`Running since ${timestampLabel(startedAt)}`);
  expect(time?.title).toMatch(/^Running since \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
  // Earlier Attempts and their failures are shown only in the Run drawer.
  expect(running.textContent).not.toContain("Attempt");
  expect(running.textContent).not.toContain("The Worker restarted");
});

it("times a waiting Run from its opening and a failed one from its failure, with a still mark", async () => {
  const waiting = runLine(cardOf(/^Retry salvage/u), "Waiting");
  expect(waiting.textContent).toBe("implementWaiting3mdeveloper");
  expect(markAnimation(waiting)).toBe("none");
  const openedAt = runOf("run-salvage").openedAt;
  expect(waiting.querySelector("time")?.title).toBe(`Opened ${timestampLabel(openedAt)}`);

  const failed = runLine(cardOf(/^Pin GitHub Actions/u), "Failed");
  expect(failed.textContent).toBe("reviewFailed1hreviewer");
  expect(markAnimation(failed)).toBe("none");
  const endedAt = runOf("run-pinned").attempts[0]?.endedAt ?? "";
  expect(failed.querySelector("time")?.title).toBe(`Failed at ${timestampLabel(endedAt)}`);
});

it("shows a card whose running Run's Loop removed its lane label in that lane, counted, with its Run line", async () => {
  overview = boardOverviewReviewing();
  await commands.boardResponses(JSON.stringify(Schema.encodeSync(FactoryOverview)(overview)), 200);
  flushSync(() => queryClient.setQueryData(["overview"], overview));
  const review = lane("Review");
  await expect.element(review.getByRole("heading", { name: "Review 2" })).toBeVisible();
  const card = cardOf(/^Keep a running card/u);
  expect(review.element().contains(card)).toBe(true);
  // The Pull requests lane, which routes by state only, still has its two cards.
  await expect
    .element(lane("Pull requests").getByRole("heading", { name: "Pull requests 2" }))
    .toBeVisible();
  expect(lane("Pull requests").element().contains(card)).toBe(false);
  await expect.element(page.getByText("8 lanes, 12 items", { exact: true })).toBeVisible();
  const row = runLine(card, "Running");
  expect(row.textContent).toBe("reviewRunning2mreviewer");
  expect(markAnimation(row)).not.toBe("none");
  // The card shows the pull request's current labels.
  expect([...card.querySelectorAll("[data-slot=badge]")].map((badge) => badge.textContent)).toEqual(
    ["ci"],
  );
});

it("shows a running card whose Loop swapped its lane label in the lane of its current labels, with its Run line", async () => {
  overview = boardOverviewReviewing();
  await commands.boardResponses(JSON.stringify(Schema.encodeSync(FactoryOverview)(overview)), 200);
  flushSync(() => queryClient.setQueryData(["overview"], overview));
  const inProgress = lane("In progress");
  await expect.element(inProgress.getByRole("heading", { name: "In progress 2" })).toBeVisible();
  const card = cardOf(/^Move a running card/u);
  expect(inProgress.element().contains(card)).toBe(true);
  await expect.element(lane("Ready").getByRole("heading", { name: "Ready 1" })).toBeVisible();
  expect(lane("Ready").element().contains(card)).toBe(false);
  const row = runLine(card, "Running");
  expect(row.textContent).toBe("implementRunning1mdeveloper");
  expect(markAnimation(row)).not.toBe("none");
});

it("offers Retry beside the failure only on the card whose Run failed", async () => {
  const failed = page.elementLocator(cardOf(/^Pin GitHub Actions/u));
  await expect.element(failed.getByText("The required check lint failed")).toBeVisible();
  await expect.element(failed.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: "Retry", exact: true }).elements()).toHaveLength(1);
});

it("draws the flow between adjacent authored label lanes, named after the Loops that watch the left one", async () => {
  const flow = (name: string) => lane(name).element().querySelector("[data-slot=flow-arrow]");
  expect(flow("Backlog")?.textContent).toBe("Flows to Ready");
  expect(flow("Ready")?.textContent).toBe("Flows to In progressimplement");
  expect(flow("Ready")?.classList).toContain("text-run-waiting");
  // implement runs on the Task, but its trigger no longer matches it, so the lane does not list it.
  expect(flow("In progress")?.textContent).toBe("Flows to Review");
  expect(flow("Review")?.textContent).toBe("Flows to Mergereview paused");
  expect(flow("Review")?.classList).toContain("text-muted-foreground");
  expect(flow("Review")?.getAttribute("title")).toBe(
    "Loops matching this lane: review (paused). Flows to Merge",
  );
  // Pull requests is read-only, so neither Merge nor Pull requests flows into a next lane.
  expect(flow("Merge")).toBeNull();
  expect(flow("Pull requests")).toBeNull();
});

it("leaves canceled and succeeded Runs off the card", async () => {
  await openDone();
  for (const card of [cardOf(/^Cache the label catalog/u), cardOf(/^Show the salvage branch/u)]) {
    expect(card.querySelector("time")).toBeNull();
    expect(card.querySelector("[data-slot=state-mark]")).toBeNull();
    // A stall note can say how the Run ended; the card has no Run line for it.
    const stall = card.querySelector("[data-slot=stall-note]")?.textContent ?? "";
    expect(card.textContent?.replace(stall, "")).not.toMatch(/Canceled|Succeeded/u);
  }
});

it("opens the Task page from anywhere on the card body, with or without a Run", async () => {
  await userEvent.click(page.elementLocator(cardOf(/^Retry salvage/u)), {
    position: { x: 24, y: 70 },
  });
  await expect.poll(() => router.state.location.pathname).toBe("/projects/board-test/repo/tasks/7");
  expect(opened).toEqual([]);
  await userEvent.click(page.elementLocator(cardOf(/^Document the cycle budget/u)), {
    position: { x: 24, y: 40 },
  });
  await expect
    .poll(() => router.state.location.pathname)
    .toBe("/projects/board-test/repo/tasks/12");
  // A Task with an issue and its pull request opens at the issue's number.
  await userEvent.click(page.elementLocator(cardOf(/^Redesign the Board columns/u)));
  await expect.poll(() => router.state.location.pathname).toBe("/projects/board-test/repo/tasks/9");
});

it("lists only the actions that apply to a card without a Run", async () => {
  await actions(12).click();
  expect(await menuContents()).toEqual({
    items: ["Open #12 on GitHub", "Move to"],
    separators: 1,
  });
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  // If the latest Run was canceled, the card has no Run line, so Run again shows the Loop.
  await actions(18).click();
  expect(await menuContents()).toEqual({
    items: ["Open #18 on GitHub", "Run history", "Run againimplement", "Move to"],
    separators: 3,
  });
});

const runAgainBody = (result: RunAgainResult) =>
  JSON.stringify(Schema.encodeSync(RunAgainResult)(result));

const runDroppedAgain = async () => {
  await commands.delayRunAgain();
  await actions(18).click();
  await page.getByRole("menuitem", { name: "Run again" }).click();
};

it("runs a Task's canceled Run again from the card menu, says so on the card, and opens the new Run", async () => {
  const card = page.elementLocator(cardOf(/^Cache the label catalog/u));
  await runDroppedAgain();
  await expect.element(card.getByText(runAgainProgress, { exact: true })).toBeVisible();
  // While the request is in flight, the menu offers no action that a second click could send.
  await actions(18).click();
  expect((await menuContents()).items).toEqual(["Open #18 on GitHub", "Run history", "Move to"]);
  await userEvent.keyboard("{Escape}");
  const sent = await commands.releaseRunAgain(
    200,
    runAgainBody(
      new Claimed({ eventId: EventId.make("run-again-event"), runId: RunId.make("run-again") }),
    ),
  );
  expect(sent).toEqual({
    path: "/api/runs/run-dropped/run-again",
    body: { task: "Work on #18.", agent: "developer" },
  });
  await expect.poll(() => opened).toEqual(["run-again"]);
  await expect.element(card.getByText(runAgainProgress, { exact: true })).not.toBeInTheDocument();
});

it("keeps a card's Run again through a move to another lane and opens the new Run", async () => {
  await runDroppedAgain();
  await actions(18).click();
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  // The card remounts in its new lane, still waiting for the response.
  await expect.element(lane("In progress").getByText(/^Cache the label catalog/u)).toBeVisible();
  const moved = page.elementLocator(cardOf(/^Cache the label catalog/u));
  await expect.element(moved.getByText(runAgainProgress, { exact: true })).toBeVisible();
  // The remounted card does not offer Run again before the response arrives.
  await actions(18).click();
  expect((await menuContents()).items).not.toContain("Run againimplement");
  await userEvent.keyboard("{Escape}");
  await commands.releaseRunAgain(
    200,
    runAgainBody(
      new Claimed({ eventId: EventId.make("run-again-event"), runId: RunId.make("run-again") }),
    ),
  );
  await expect.poll(() => opened).toEqual(["run-again"]);
  await expect.element(moved.getByText(runAgainProgress, { exact: true })).not.toBeInTheDocument();
});

it("says on the card why Run again opened no Run: a refusal, then a used-up cycle budget", async () => {
  const card = page.elementLocator(cardOf(/^Cache the label catalog/u));
  const refusal =
    "Cannot run Run run-dropped again: Run run-newer of Loop implement is open on the same Item. Cancel Run run-newer, or try again after it closes.";
  await runDroppedAgain();
  await commands.releaseRunAgain(
    409,
    JSON.stringify({ error: "RunRetryBlockedError", message: refusal }),
  );
  await expect.element(card.getByText(refusal, { exact: true })).toBeVisible();

  const dropped = runOf("run-dropped");
  await runDroppedAgain();
  await commands.releaseRunAgain(
    200,
    runAgainBody(
      new CycleBlocked({
        eventId: EventId.make("run-again-event"),
        ask: new CycleBudgetAsk({
          id: CycleBudgetAskId.make("exhausted"),
          itemKey: dropped.itemKey,
          repository: dropped.repository,
          loop: dropped.loop,
          limit: CycleLimit.make(1),
          counts: [
            new LoopCycleCount({
              loop: dropped.loop,
              admitted: CycleCount.make(1),
              completed: CycleCount.make(1),
            }),
          ],
        }),
      }),
    ),
  );
  await expect.element(card.getByText(runAgainBlocked, { exact: true })).toBeVisible();
  await expect.element(card.getByText(refusal, { exact: true })).not.toBeInTheDocument();
  expect(opened).toEqual([]);
});

it("lists the current Run's applicable actions and moves the card through Move to", async () => {
  await actions(7).click();
  expect(opened).toEqual([]);
  expect(await menuContents()).toEqual({
    items: ["Open #7 on GitHub", "Open run", "Approve", "Cancel run", "Move to"],
    separators: 3,
  });
  await expect
    .element(page.getByRole("menuitem", { name: "Open Issue #7, open on GitHub" }))
    .toHaveAttribute("href", "https://github.com/board-test/repo/issues/7");
  expect(page.getByRole("menu").element().querySelector("[aria-disabled=true]")).toBeNull();

  await page.getByRole("menuitem", { name: "Move to" }).click();
  const destinations = page.getByRole("menu").last().getByRole("menuitem");
  await expect
    .poll(() => destinations.elements().map((item) => item.textContent))
    .toEqual(["Backlog", "In progress", "Review", "Merge"]);
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(lane("In progress").getByText(/^Retry salvage/u)).toBeVisible();
  await expect
    .element(lane("In progress").getByRole("status"))
    .toHaveTextContent("Saved on GitHub");
  await expect.element(lane("Ready").getByText(/^Retry salvage/u)).not.toBeInTheDocument();
});

it("offers Retry for a failed Run and Cancel run alone for a running one", async () => {
  await page.getByRole("button", { name: "Actions for pull request #28", exact: true }).click();
  expect((await menuContents()).items).toEqual([
    "Open #28 on GitHub",
    "Open run",
    "Retry",
    "Move to",
  ]);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Actions for pull request #31", exact: true }).click();
  expect((await menuContents()).items).toEqual([
    "Open #9 on GitHub",
    "Open #31 on GitHub",
    "Open run",
    "Run history",
    "Cancel run",
    "Move to",
  ]);
});

it("tints only the column a keyboard drag is over", async () => {
  const card = cardOf(/^Retry salvage/u);
  card.focus();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowRight}");
  const tinted = () =>
    ["Backlog", "Ready", "In progress", "Review", "Merge", "Pull requests"].filter((name) =>
      lane(name).element().classList.contains("bg-muted/40"),
    );
  await expect.poll(tinted).toEqual(["In progress"]);
  await userEvent.keyboard("{Escape}");
  await expect.poll(tinted).toEqual([]);
});
