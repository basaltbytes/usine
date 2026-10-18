import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import type { RunId } from "@usine/core/run";
import { FactoryOverview, type ReadyOverview, type RunView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { ProjectBoard } from "../src/board/board.tsx";
import { timestampLabel } from "../src/operator-copy.ts";
import { overviewQuery } from "../src/overview.ts";
import { boardOverview } from "./board-fixture.ts";
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

const Board = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  const project = data.projects[0];
  if (project === undefined) return null;
  return <ProjectBoard project={project} disabled={false} openRun={(id) => opened.push(id)} />;
};

const lane = (name: string) => page.getByLabelText(`${name} lane`);
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
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Board />
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
  const closed = sources("Done").getByText("issue-closed", { exact: true }).element();
  expect(closed.getAttribute("style")).toBeNull();
  expect(closed.classList).toContain("text-muted-foreground");
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

it("times a running Run from its current Attempt, on one line with a pulsing dot", async () => {
  const running = cardOf(/^Redesign the Board/u);
  expect(running.textContent).toContain("#9 Issue#31 Pull request");
  const row = runLine(running, "Running");
  expect(row.textContent).toBe("implementRunning6mdeveloper");
  const state = page.elementLocator(running).getByText("Running", { exact: true }).element();
  expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(
    Number.parseFloat(getComputedStyle(state).lineHeight) + 1,
  );
  expect(getComputedStyle(state.querySelector("[aria-hidden]") ?? state).animationName).not.toBe(
    "none",
  );
  const startedAt = runOf("run-redesign").attempts[1]?.startedAt ?? "";
  const time = row.querySelector("time");
  expect(time?.dateTime).toBe(startedAt);
  expect(time?.title).toBe(`Running since ${timestampLabel(startedAt)}`);
  expect(time?.title).toMatch(/^Running since \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
  // Earlier Attempts and their failures stay in the Run drawer.
  expect(running.textContent).not.toContain("Attempt");
  expect(running.textContent).not.toContain("The Worker restarted");
});

it("times a waiting Run from its opening and a failed one from its failure, without a dot", async () => {
  const waiting = runLine(cardOf(/^Retry salvage/u), "Waiting");
  expect(waiting.textContent).toBe("implementWaiting3mdeveloper");
  expect(waiting.querySelector("[aria-hidden]")).toBeNull();
  const openedAt = runOf("run-salvage").openedAt;
  expect(waiting.querySelector("time")?.title).toBe(`Opened ${timestampLabel(openedAt)}`);

  const failed = runLine(cardOf(/^Pin GitHub Actions/u), "Failed");
  expect(failed.textContent).toBe("reviewFailed1hreviewer");
  expect(failed.querySelector("[aria-hidden]")).toBeNull();
  const endedAt = runOf("run-pinned").attempts[0]?.endedAt ?? "";
  expect(failed.querySelector("time")?.title).toBe(`Failed at ${timestampLabel(endedAt)}`);
});

it("leaves canceled and succeeded Runs off the card", async () => {
  for (const card of [cardOf(/^Cache the label catalog/u), cardOf(/^Show the salvage branch/u)]) {
    expect(card.querySelector("time")).toBeNull();
    expect(card.textContent).not.toMatch(/Canceled|Succeeded|implement/u);
  }
});

it("opens the Run drawer from anywhere on the card body", async () => {
  await userEvent.click(page.elementLocator(cardOf(/^Retry salvage/u)), {
    position: { x: 24, y: 70 },
  });
  expect(opened).toEqual(["run-salvage"]);
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
