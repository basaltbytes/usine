import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import type { RunId } from "@usine/core/run";
import { FactoryOverview, type ReadyOverview, type RunView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { RouterProvider } from "@tanstack/react-router";
import { ProjectBoard } from "../src/board/board.tsx";
import { timestampLabel } from "../src/operator-copy.ts";
import { overviewQuery } from "../src/overview.ts";
import { boardOverview } from "./board-fixture.ts";
import { memoryRouter } from "./memory-router.tsx";
import "../src/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    boardResponses: (overview: string, moveStatus: 200 | 503) => Promise<void>;
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
  return <ProjectBoard project={project} disabled={false} openRun={(id) => opened.push(id)} />;
};

const lane = (name: string) => page.getByLabelText(`${name} lane`);
/** Done holds only closed Items, so it opens folded into a rail. */
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
/** The Run line of a card: the row holding the Run's state. */
const runLine = (card: HTMLElement, state: string) => {
  const row = page.elementLocator(card).getByText(state, { exact: true }).element().parentElement;
  if (row === null) throw new Error(`No ${state} Run line`);
  return row;
};
/** The open menu's items, then the number of separators between its groups. */
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

it("puts the lanes that accept moves first and folds the lane of closed Items into a rail", async () => {
  const names = [...document.querySelectorAll("section[aria-label$=' lane']")].map((section) =>
    section.getAttribute("aria-label"),
  );
  expect(names).toEqual([
    "Backlog lane",
    "Ready lane",
    "In progress lane",
    "Review lane",
    "Done lane",
  ]);
  const rail = lane("Done").getByRole("button", { name: "Done 1" });
  await expect.element(rail).toHaveAttribute("aria-expanded", "false");
  expect(lane("Done").element().getBoundingClientRect().width).toBeLessThanOrEqual(40);
  await openDone();
  await expect.element(lane("Done").getByText(/^Show the salvage branch/u)).toBeVisible();
  await lane("Done").getByRole("button", { name: "Fold Done", exact: true }).click();
  await expect.element(lane("Done").getByRole("button", { name: "Done 1" })).toBeVisible();
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
  // Focus is in the menu now, away from the card and its button.
  expect(actions(12).element().matches(":focus-within, :hover")).toBe(false);
  await expect.poll(opacity).toBe("1");
});

it("shows the number and kind, a title clamped to two lines, and only labels the lane does not name", async () => {
  const card = cardOf(/^Reader restore test/u);
  expect(card.textContent).toContain("#15 Issue");
  expect(card.textContent).not.toContain("Issue #15");

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

/** The animation of the state mark that opens a Run line. */
const markAnimation = (row: HTMLElement) => {
  const mark = row.querySelector("[data-slot=state-mark]");
  if (mark === null) throw new Error("No state mark on the Run line");
  return getComputedStyle(mark).animationName;
};

it("times a running Run from its current Attempt, on one line with a pulsing mark", async () => {
  const running = cardOf(/^Redesign the Board/u);
  expect(running.textContent).toContain("#9 Issue#31 PR");
  await expect
    .element(page.elementLocator(running).getByText("Pull request #31", { exact: true }))
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
  // Earlier Attempts and their failures stay in the Run drawer.
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

it("offers Retry beside the failure only on the card whose Run failed", async () => {
  const failed = page.elementLocator(cardOf(/^Pin GitHub Actions/u));
  await expect.element(failed.getByText("The required check lint failed")).toBeVisible();
  await expect.element(failed.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: "Retry", exact: true }).elements()).toHaveLength(1);
});

it("draws the flow between adjacent authored label lanes, named after the Loops at work", async () => {
  const flow = (name: string) => lane(name).element().querySelector("[data-slot=flow-arrow]");
  expect(flow("Backlog")?.textContent).toBe("Flows to Ready");
  expect(flow("Ready")?.textContent).toBe("Flows to In progressimplement");
  expect(flow("Ready")?.classList).toContain("text-run-waiting");
  expect(flow("In progress")?.textContent).toBe("Flows to Reviewimplement");
  expect(flow("In progress")?.classList).toContain("text-run-active");
  // Done is read-only, so Review has no next bay to flow into.
  expect(flow("Review")).toBeNull();
  expect(flow("Done")).toBeNull();
});

it("leaves canceled and succeeded Runs off the card", async () => {
  await openDone();
  for (const card of [cardOf(/^Cache the label catalog/u), cardOf(/^Show the salvage branch/u)]) {
    expect(card.querySelector("time")).toBeNull();
    expect(card.textContent).not.toMatch(/Canceled|Succeeded|implement/u);
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
  // A Task joining an issue and its pull request opens under the issue.
  await userEvent.click(page.elementLocator(cardOf(/^Redesign the Board columns/u)));
  await expect.poll(() => router.state.location.pathname).toBe("/projects/board-test/repo/tasks/9");
});

it("lists only the actions that apply to a card without a Run", async () => {
  await actions(12).click();
  expect(await menuContents()).toEqual({ items: ["Open #12 on GitHub", "Move to"], separators: 1 });
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  await actions(18).click();
  expect(await menuContents()).toEqual({
    items: ["Open #18 on GitHub", "Run history", "Move to"],
    separators: 2,
  });
});

it("lists the current Run's applicable actions and moves the card through Move to", async () => {
  await actions(7).click();
  expect(opened).toEqual([]);
  expect(await menuContents()).toEqual({
    items: ["Open #7 on GitHub", "Open Run", "Approve", "Cancel Run", "Move to"],
    separators: 3,
  });
  await expect
    .element(page.getByRole("menuitem", { name: "Open #7 on GitHub" }))
    .toHaveAttribute("href", "https://github.com/board-test/repo/issues/7");
  expect(page.getByRole("menu").element().querySelector("[aria-disabled=true]")).toBeNull();

  await page.getByRole("menuitem", { name: "Move to" }).click();
  const destinations = page.getByRole("menu").last().getByRole("menuitem");
  await expect
    .poll(() => destinations.elements().map((item) => item.textContent))
    .toEqual(["Backlog", "In progress", "Review"]);
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(lane("In progress").getByText(/^Retry salvage/u)).toBeVisible();
  await expect
    .element(lane("In progress").getByRole("status"))
    .toHaveTextContent("Saved on GitHub");
  await expect.element(lane("Ready").getByText(/^Retry salvage/u)).not.toBeInTheDocument();
});

it("offers Retry for a failed Run and Cancel Run alone for a running one", async () => {
  await page.getByRole("button", { name: "Actions for pull request #28", exact: true }).click();
  expect((await menuContents()).items).toEqual([
    "Open #28 on GitHub",
    "Open Run",
    "Retry",
    "Move to",
  ]);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Actions for pull request #31", exact: true }).click();
  expect((await menuContents()).items).toEqual([
    "Open #9 on GitHub",
    "Open #31 on GitHub",
    "Open Run",
    "Run history",
    "Cancel Run",
    "Move to",
  ]);
});

it("tints only the column a keyboard drag is over", async () => {
  const card = cardOf(/^Retry salvage/u);
  card.focus();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowRight}");
  const tinted = () =>
    ["Backlog", "Ready", "In progress", "Review", "Done"].filter((name) =>
      lane(name).element().classList.contains("bg-muted/40"),
    );
  await expect.poll(tinted).toEqual(["In progress"]);
  await userEvent.keyboard("{Escape}");
  await expect.poll(tinted).toEqual([]);
});
