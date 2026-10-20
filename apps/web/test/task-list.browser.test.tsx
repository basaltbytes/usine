import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { BoardView, DeskView, ProjectView, ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { routeTree } from "../src/route-tree.gen.ts";
import {
  boardOverview,
  boardOverviewResolved,
  boardOverviewUnpriced,
  boardStalled,
} from "./board-fixture.ts";
import "../src/index.css";

const list = "/projects/board-test/repo/tasks";

// A Task page asks for its Task; this stand-in server knows none, so only the address matters.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ error: "BoardItemNotFoundError", message: "No Task" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

const desk = (notMoving: ReturnType<typeof boardStalled>) =>
  new DeskView({ running: [], notMoving, lastOutcomes: [], workers: [], polls: [] });

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let router: ReturnType<typeof createRouter>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["overview"], boardOverview());
  queryClient.setQueryData(["desk"], desk(boardStalled()));
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

// Wide enough, beside the sidebar, for every column.
const mount = async (path: string, width = 1440) => {
  await page.viewport(width, 900);
  router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  await router.load();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await expect.element(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
};

const table = () => page.getByRole("table", { name: "board-test/repo tasks" });
const rowOf = (title: RegExp) => table().getByRole("row").filter({ hasText: title });
/** The text of each row's Task and Status cells, in the table's order. */
const rowTexts = () =>
  table()
    .getByRole("row")
    .elements()
    .slice(1)
    .map((row) =>
      [...row.querySelectorAll("td")].slice(0, 2).map((cell) => cell.textContent.trim()),
    );
/** The headings of the columns on screen. */
const columns = () =>
  [...table().element().querySelectorAll("th")]
    .filter((header) => header.checkVisibility())
    .map((header) => header.textContent);
const crumbs = () => page.getByRole("navigation", { name: "breadcrumb" });
const crumbTexts = () =>
  crumbs()
    .getByRole("listitem")
    .elements()
    .map((item) => item.textContent);
const sidebarLink = (name: string) => {
  const sidebar = document.querySelector("[data-slot=sidebar-inner]");
  if (!(sidebar instanceof HTMLElement)) throw new Error("No sidebar");
  return page.elementLocator(sidebar).getByRole("link", { name, exact: true });
};

it("lists only the tasks with runs, in flight first, with their status, runs, last run, pull request, time, tokens, and cost", async () => {
  await mount(list);
  await expect.element(page.getByText("5 in flight, 1 done", { exact: true })).toBeVisible();
  // Every listed task added up: 41, 15, 10, and 30 min of attempts, and the priced tasks' dollars.
  await expect
    .element(page.getByText("7 runs, 1 h 36 min, 87.3K tokens, $5.50 estimate", { exact: true }))
    .toBeVisible();
  expect(columns()).toEqual([
    "Task",
    "Status",
    "Runs",
    "Last run",
    "Pull request",
    "Time",
    "Tokens",
    "Cost",
  ]);
  // Running, then waiting for approval, then queued and stalled by when the run opened, then
  // the merged task; the four tasks no loop ever ran on are absent. A task reads as its
  // originating issue.
  await expect.poll(rowTexts).toEqual([
    ["#9Redesign the Board columns and cards", "Running implement"],
    [
      "#7Retry salvage pushes when the Worker loses its network mid-Attempt",
      "Waiting for approval",
    ],
    ["#44Pin the Node version of the release workflow", "Queued"],
    [
      "#28Pin GitHub Actions to commit SHAs and add Dependabot for them",
      "Failed 1h ago: Agent failure",
    ],
    [
      "#18Cache the label catalog per repository",
      expect.stringMatching(/^Canceled \d+h ago, unchanged since$/u),
    ],
    ["#5Show the salvage branch on failed Attempts", "Done"],
  ]);

  const redesign = rowOf(/Redesign the Board columns/u);
  // Each loop once, in the order it first ran, with its last run's state, then the run count.
  await expect.element(redesign).toHaveTextContent("plan Succeeded · implement Running2");
  await expect.element(redesign).toHaveTextContent(/implementRunning6m ago/u);
  await expect
    .element(redesign.getByRole("link", { name: "#31", exact: true }))
    .toHaveAttribute("href", "https://github.com/board-test/repo/pull/31");
  // The pull request, then a priced run and one on the ChatGPT plan: their time, their tokens,
  // and the priced dollars.
  await expect.element(redesign).toHaveTextContent(/#31open41 min27\.3K\$2\.00 estimate$/u);
  await expect
    .element(rowOf(/Show the salvage branch/u))
    .toHaveTextContent(/#6merged30 min48K\$3\.10 estimate$/u);
  // No attempt began on the waiting task, and the canceled one reported no tokens.
  await expect.element(rowOf(/Retry salvage pushes/u)).toHaveTextContent(/3m ago$/u);
  await expect.element(rowOf(/Cache the label catalog/u)).toHaveTextContent(/ago10 min$/u);
  expect(rowOf(/Document the cycle budget reset/u).elements()).toHaveLength(0);
});

it("opens the tokens per pool, summed over the task's runs, from the tokens or the cost", async () => {
  await mount(list);
  const redesign = rowOf(/Redesign the Board columns/u);
  await redesign.getByRole("button", { name: "Tokens: 27.3K. Show them per pool" }).hover();
  const pools = page.getByRole("region", { name: "Tokens per pool" });
  await expect.element(pools).toBeVisible();
  await expect.element(pools).toHaveTextContent("API keys1,500$0.75");
  await expect.element(pools).toHaveTextContent("Claude plan20,000$1.25 estimate");
  await expect.element(pools).toHaveTextContent("ChatGPT plan5,800No dollar rate");
  await page.getByRole("heading", { name: "Tasks", level: 1 }).hover();
  await expect.element(pools).not.toBeInTheDocument();

  await redesign.getByRole("button", { name: "Cost: $2.00 estimate. Show it per pool" }).hover();
  await expect.element(pools).toHaveTextContent("Claude plan20,000$1.25 estimate");
});

it("keeps the priced dollars as a lower bound while a run has no price yet", async () => {
  queryClient.setQueryData(["overview"], boardOverviewUnpriced());
  await mount(list);
  await expect
    .element(
      page.getByText("7 runs, 1 h 36 min, 87.5K tokens, at least $5.50 estimate", {
        exact: true,
      }),
    )
    .toBeVisible();
  const redesign = rowOf(/Redesign the Board columns/u);
  await expect
    .element(redesign)
    .toHaveTextContent(/#31open41 min27\.5Kat least \$2\.00 estimate$/u);
  await redesign
    .getByRole("button", { name: "Cost: at least $2.00 estimate. Show it per pool" })
    .hover();
  const pools = page.getByRole("region", { name: "Tokens per pool" });
  await expect.element(pools).toHaveTextContent("API keys1,500$0.75");
  await expect.element(pools).toHaveTextContent("Claude plan26,000at least $1.25 estimate");
  // The price stays on one line beside the tokens.
  const price = pools.getByText("at least", { exact: true }).element().parentElement;
  expect(price?.getBoundingClientRect().height).toBeLessThan(24);
});

it("says Needs attention for a failure no stall explains, then the last run's outcome once it is resolved", async () => {
  queryClient.setQueryData(["desk"], desk(boardStalled().filter(({ item }) => item.number !== 28)));
  await mount(list);
  await expect
    .element(page.getByText("4 in flight, 1 needs attention, 1 done", { exact: true }))
    .toBeVisible();
  const pinned = rowOf(/Pin GitHub Actions/u);
  await expect.element(pinned.getByRole("cell").nth(1)).toHaveTextContent("Needs attention");
  // It ended 80m ago and still follows #18, stalled since its run opened a day ago.
  await expect.element(pinned).toBe(table().getByRole("row").nth(5).element());

  queryClient.setQueryData(["overview"], boardOverviewResolved());
  await expect.element(pinned.getByRole("cell").nth(1)).toHaveTextContent(/^Failed$/u);
  await expect.element(page.getByText("4 in flight, 1 done", { exact: true })).toBeVisible();
});

it("says No runs yet when no task has a run", async () => {
  const overview = boardOverview();
  queryClient.setQueryData(
    ["overview"],
    new ReadyOverview({
      ...overview,
      projects: overview.projects.map(
        (project) =>
          new ProjectView({
            ...project,
            board: new BoardView({
              failures: [],
              lanes: project.board.lanes.filter(({ items }) =>
                items.every(({ runs }) => runs.length === 0),
              ),
            }),
          }),
      ),
    }),
  );
  await mount(list);
  const heading = page.getByRole("heading", { name: "Tasks", level: 1 }).element().parentElement;
  await expect.element(page.getByText("No runs yet", { exact: true })).toBeVisible();
  expect(heading?.textContent).toBe("Tasks");
  expect(table().elements()).toHaveLength(0);
});

it("opens the task page from anywhere on a row, under its originating item", async () => {
  await mount(list);
  // A click on the Runs cell, which holds no link of its own, opens the task page too.
  const row = rowOf(/Redesign the Board columns/u);
  const runs = row.getByRole("cell").nth(2).element().getBoundingClientRect();
  const bounds = row.element().getBoundingClientRect();
  await userEvent.click(row, {
    position: { x: runs.left - bounds.left + runs.width / 2, y: bounds.height / 2 },
  });
  await expect.poll(() => router.state.location.pathname).toBe(`${list}/9`);
  await expect.poll(crumbTexts).toEqual(["board-test/repo", "Tasks", "#9"]);
  await crumbs().getByRole("link", { name: "Tasks", exact: true }).click();
  await expect.poll(() => router.state.location.pathname).toBe(list);
});

it("shows Board and Tasks under the project in the sidebar, the open page's row active", async () => {
  await mount(list);
  await expect.poll(crumbTexts).toEqual(["board-test/repo", "Tasks"]);
  await expect
    .element(crumbs().getByRole("link", { name: "board-test/repo" }))
    .toHaveAttribute("href", "/projects/board-test/repo");
  await expect.element(sidebarLink("Tasks")).toHaveAttribute("data-active");
  await expect.element(sidebarLink("Board")).not.toHaveAttribute("data-active");
  await expect.element(sidebarLink("board-test/repo")).not.toHaveAttribute("data-active");

  await sidebarLink("Board").click();
  await expect.poll(() => router.state.location.pathname).toBe("/projects/board-test/repo");
  await expect.element(sidebarLink("Board")).toHaveAttribute("data-active");
  await expect.element(sidebarLink("Tasks")).not.toHaveAttribute("data-active");
});

it("drops Runs and Pull request beside the sidebar on a mid-size window", async () => {
  await mount(list, 1280);
  await expect.poll(columns).toEqual(["Task", "Status", "Last run", "Time", "Tokens", "Cost"]);
  const title = rowOf(/Redesign the Board/u).getByRole("link", { name: /Redesign the Board/u });
  expect(title.element().getBoundingClientRect().width).toBeGreaterThan(240);
});

it("keeps only Time of the totals on a phone, without scrolling sideways", async () => {
  await mount(list, 390);
  await expect.poll(columns).toEqual(["Task", "Status", "Last run", "Time"]);
  // A long status wraps instead of squeezing the title out, beside the time.
  const title = rowOf(/Pin GitHub Actions/u).getByRole("link", { name: /Pin GitHub Actions/u });
  expect(title.element().getBoundingClientRect().width).toBeGreaterThan(100);
  const container = table().element().parentElement;
  expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
});
