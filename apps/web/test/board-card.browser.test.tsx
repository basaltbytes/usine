import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import type { RunId } from "@usine/core/run";
import { FactoryOverview } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { ProjectBoard } from "../src/board/board.tsx";
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

beforeEach(async () => {
  await page.viewport(1280, 800);
  const overview = boardOverview();
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

it("shows the open Run on one line, with a pulsing dot only while an Attempt runs", async () => {
  const running = cardOf(/^Redesign the Board/u);
  expect(running.textContent).toContain("#9 Issue#31 Pull request");
  const line = page.elementLocator(running).getByText("Running", { exact: true }).element();
  const row = line.parentElement;
  expect(row?.textContent).toBe("implementRunning12mdeveloper");
  expect(row?.getBoundingClientRect().height).toBeLessThanOrEqual(
    Number.parseFloat(getComputedStyle(line).lineHeight) + 1,
  );
  expect(getComputedStyle(line.querySelector("[aria-hidden]") ?? line).animationName).not.toBe(
    "none",
  );
  // Earlier Attempts and their failures stay in the Run drawer.
  expect(running.textContent).not.toContain("Attempt");
  expect(running.textContent).not.toContain("The Worker restarted");

  const waiting = page
    .elementLocator(cardOf(/^Retry salvage/u))
    .getByText("Waiting")
    .element();
  expect(getComputedStyle(waiting.querySelector("[aria-hidden]") ?? waiting).animationName).toBe(
    "none",
  );
});

it("opens the Run drawer from anywhere on the card body", async () => {
  await userEvent.click(page.elementLocator(cardOf(/^Retry salvage/u)), {
    position: { x: 24, y: 70 },
  });
  expect(opened).toEqual(["run-salvage"]);
});

it("lists the card's actions behind its menu button and moves the card through Move to", async () => {
  await actions(7).click();
  expect(opened).toEqual([]);
  await expect
    .element(page.getByRole("menuitem", { name: "Open #7 on GitHub" }))
    .toHaveAttribute("href", "https://github.com/board-test/repo/issues/7");
  await expect.element(page.getByRole("menuitem", { name: "Open Run" })).toBeVisible();
  await expect
    .element(page.getByRole("menuitem", { name: "Approve" }))
    .not.toHaveAttribute("aria-disabled", "true");
  await expect
    .element(page.getByRole("menuitem", { name: "Retry" }))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(page.getByRole("menuitem", { name: "Cancel Run" }))
    .not.toHaveAttribute("aria-disabled", "true");

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
