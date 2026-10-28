import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { BoardView, DeskView, ProjectView, ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { overviewQuery } from "~/lib/overview";
import { deskQuery } from "~/lib/desk/queries";
import { routeTree } from "~/route-tree.gen";
import {
  boardOverview,
  boardOverviewDocumented,
  boardOverviewDocumentedLongLoop,
  boardOverviewResolved,
  boardOverviewUnpriced,
  boardOverviewUntimed,
  boardStalled,
} from "~/lib/projects/fixture";
import "~/index.css";

const list = "/projects/board-test/repo/tasks";

// Task pages request their Task; this fake server returns not found, so only the URL is checked.
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
  queryClient.setQueryData(overviewQuery().queryKey, boardOverview());
  queryClient.setQueryData(deskQuery().queryKey, desk(boardStalled()));
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

// The default width fits every column next to the sidebar.
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
  // The columns widen when Inter replaces the fallback font, which moves what a measured click hits.
  await document.fonts.ready;
};

const table = () => page.getByRole("table", { name: "board-test/repo tasks" });
const rowOf = (title: RegExp) => table().getByRole("row").filter({ hasText: title });
/** Returns the Task and Status cell text of each row, in table order. */
const rowTexts = () =>
  table()
    .getByRole("row")
    .elements()
    .slice(1)
    .map((row) =>
      [...row.querySelectorAll("td")].slice(0, 2).map((cell) => cell.textContent.trim()),
    );
const cellTexts = (title: RegExp) =>
  rowOf(title)
    .getByRole("cell")
    .elements()
    .map((cell) => cell.textContent);
const columns = () =>
  [...table().element().querySelectorAll("th")]
    .filter((header) => header.checkVisibility())
    .map((header) => header.textContent);
const crumbs = () => page.getByRole("navigation", { name: "breadcrumb" });
/**
 * Returns each crumb's text without the repository mark, which is hidden from assistive technology
 * and shows a letter instead once its image fails to load, as without network access.
 */
const crumbTexts = () =>
  crumbs()
    .getByRole("listitem")
    .elements()
    .map((item) => {
      const label = item.cloneNode(true);
      if (!(label instanceof Element)) throw new Error("Crumb is not an element");
      for (const hidden of label.querySelectorAll("[aria-hidden=true]")) hidden.remove();
      return label.textContent;
    });
const sidebarLink = (name: string) => page.getByRole("link", { name, exact: true }).first();

it("lists only the tasks with runs, in flight first, with their status and last run time, runs, pull request, elapsed time, tokens, and estimated cost", async () => {
  await mount(list);
  // The task canceled a day ago, unchanged since, is not in flight.
  await expect.element(page.getByText("4 in flight, 1 done", { exact: true })).toBeVisible();
  // Totals of all listed tasks: 41, 15, 10, and 30 min of attempts, and the priced tasks' dollars.
  await expect
    .element(
      page.getByText("7 runs, 1 h 36 min elapsed, 87.3K tokens, $5.90 estimated", { exact: true }),
    )
    .toBeVisible();
  expect(columns()).toEqual([
    "Task",
    "Status",
    "Runs",
    "Pull request",
    "Elapsed time",
    "Tokens",
    "Estimated cost",
  ]);
  // Order: running, waiting for approval, then queued and stalled by Run open time, then canceled
  // and merged by last Run close time. The four tasks no Loop ran on are not listed. Each status
  // ends with the last Run's activity time unless the stall text already has a time.
  await expect.poll(rowTexts).toEqual([
    ["#9 Redesign the Board columns and cards", "Running implement · 6m ago"],
    [
      "#7 Retry salvage pushes when the Worker loses its network mid-Attempt",
      "Waiting for approval · 3m ago",
    ],
    ["#44 Pin the Node version of the release workflow", "Queued · 2m ago"],
    [
      "#28 Pin GitHub Actions to commit SHAs and add Dependabot for them",
      "Failed 1h ago: Agent failure",
    ],
    [
      "#18 Cache the label catalog per repository",
      expect.stringMatching(/^Canceled \d+h ago, unchanged since$/u),
    ],
    ["#5 Show the salvage branch on failed Attempts", "Done · 1d ago"],
  ]);

  const redesign = rowOf(/Redesign the Board columns/u);
  // Each Loop once, in first-run order, with its last Run's state, then the Run count.
  await expect.element(redesign).toMatchTextContent("plan Succeeded · implement Running2");
  await expect
    .element(redesign.getByRole("link", { name: "Pull request #31, open", exact: true }))
    .toHaveAttribute("href", "https://github.com/board-test/repo/pull/31");
  // The pull request, then the time, tokens, and dollars of a priced Run and a ChatGPT plan Run,
  // each in its own cell.
  await expect.element(redesign).toMatchTextContent(/#3141 min27\.3K\$2\.40$/u);
  await expect
    .element(rowOf(/Show the salvage branch/u))
    .toMatchTextContent(/#630 min48K\$3\.10$/u);
  // No Attempt started on the waiting task, and the canceled one reported no tokens.
  expect(cellTexts(/Retry salvage pushes/u).slice(4)).toEqual(["", "", ""]);
  expect(cellTexts(/Cache the label catalog/u).slice(4)).toEqual(["10 min", "", ""]);
  expect(rowOf(/Document the cycle budget reset/u).elements()).toHaveLength(0);
});

it("opens the tokens per pool, summed over the task's runs, from the tokens or the cost", async () => {
  await mount(list);
  const redesign = rowOf(/Redesign the Board columns/u);
  await redesign.getByRole("button", { name: "Tokens: 27.3K. Show per pool" }).hover();
  const pools = page.getByRole("region", { name: "Tokens per pool" });
  await expect.element(pools).toBeVisible();
  await expect.element(pools).toMatchTextContent("API keys1,500$0.75");
  await expect.element(pools).toMatchTextContent("Claude plan20,000$1.25 estimate");
  await expect.element(pools).toMatchTextContent("ChatGPT plan5,800$0.40 estimate");
  await page.getByRole("heading", { name: "Tasks", level: 1 }).hover();
  await expect.element(pools).not.toBeInTheDocument();

  await redesign.getByRole("button", { name: "Estimated cost: $2.40. Show per pool" }).hover();
  await expect.element(pools).toMatchTextContent("Claude plan20,000$1.25 estimate");
});

it("marks the priced dollars with an asterisk while a run has no price yet, and says why", async () => {
  queryClient.setQueryData(overviewQuery().queryKey, boardOverviewUnpriced());
  await mount(list);
  await expect
    .element(
      page.getByText("7 runs, 1 h 36 min elapsed, 87.5K tokens, $13.45* estimated", {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(page.getByText("$13.45*", { exact: true }))
    .toHaveAttribute("title", "Some sessions have no price yet; the real figure is higher");
  const redesign = rowOf(/Redesign the Board columns/u);
  await expect.element(redesign).toMatchTextContent(/#3141 min27\.5K\$9\.95\*$/u);
  await redesign
    .getByRole("button", { name: "Estimated cost: at least $9.95. Show per pool" })
    .hover();
  const pools = page.getByRole("region", { name: "Tokens per pool" });
  await expect.element(pools).toMatchTextContent("API keys1,500$0.75");
  await expect.element(pools).toMatchTextContent("Claude plan26,000at least $9.20 estimate");
  // The breakdown starts with the reason the figure is marked.
  expect(pools.element().parentElement?.textContent).toMatch(
    /^Some sessions have no price yet; the real figure is higher\.Tokens per pool/u,
  );
  // The price stays on one line beside the tokens.
  const price = pools.getByText("at least", { exact: true }).element().parentElement;
  expect(price?.getBoundingClientRect().height).toBeLessThan(24);
});

it("marks the elapsed time with an asterisk while an attempt has no recorded timing, and says why", async () => {
  queryClient.setQueryData(overviewQuery().queryKey, boardOverviewUntimed());
  await mount(list);
  // The canceled task's 10 min are unknown, and every run is priced.
  await expect
    .element(
      page.getByText("7 runs, 1 h 26 min* elapsed, 87.3K tokens, $5.90 estimated", {
        exact: true,
      }),
    )
    .toBeVisible();
  const why = "Some attempts have no recorded timing; the real figure is higher";
  await expect
    .element(page.getByText("1 h 26 min*", { exact: true }))
    .toHaveAttribute("title", why);
  const time = rowOf(/Cache the label catalog/u)
    .getByRole("cell")
    .nth(4);
  await expect.element(time).toMatchTextContent(/^0s\*$/u);
  await expect.element(time.getByTitle(why)).toBeVisible();
});

it("says Needs attention for a failure no stall explains, then the last run's outcome once it is resolved", async () => {
  queryClient.setQueryData(
    deskQuery().queryKey,
    desk(boardStalled().filter(({ item }) => item.number !== 28)),
  );
  await mount(list);
  await expect
    .element(page.getByText("3 in flight, 1 needs attention, 1 done", { exact: true }))
    .toBeVisible();
  const pinned = rowOf(/Pin GitHub Actions/u);
  await expect.element(pinned.getByRole("cell").nth(1)).toMatchTextContent("Needs attention");
  // It ended 80m ago, so it comes before #18, whose run was canceled a day ago.
  await expect.element(pinned).toBe(table().getByRole("row").nth(4).element());

  queryClient.setQueryData(overviewQuery().queryKey, boardOverviewResolved());
  await expect.element(pinned.getByRole("cell").nth(1)).toMatchTextContent(/^Failed · 1h ago$/u);
  await expect.element(page.getByText("3 in flight, 1 done", { exact: true })).toBeVisible();
});

it("says No runs yet when no task has a run", async () => {
  const overview = boardOverview();
  queryClient.setQueryData(
    overviewQuery().queryKey,
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
  // Clicking the Runs cell, which has no link of its own, also opens the task page.
  const row = rowOf(/Redesign the Board columns/u);
  const runs = row.getByRole("cell").nth(2).element().getBoundingClientRect();
  const bounds = row.element().getBoundingClientRect();
  await userEvent.click(row, {
    position: { x: runs.left - bounds.left + runs.width / 2, y: bounds.height / 2 },
  });
  await expect.poll(() => router.state.location.pathname).toBe(`${list}/9`);
  await expect.poll(crumbTexts).toEqual(["board-test/repo", "Tasks", "Issue #9"]);
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

it("keeps every title on one line beside all the columns and wide figures, the long statuses wrapping instead", async () => {
  queryClient.setQueryData(overviewQuery().queryKey, boardOverviewDocumented());
  await mount(list);
  expect(columns()).toHaveLength(7);
  const merged = rowOf(/@usine\/config/u);
  await expect.element(merged.getByRole("cell").nth(1)).toMatchTextContent(/^Done · 28m ago$/u);
  await expect.element(merged).toMatchTextContent(/1 h 21 min1\.3M\$12\.62\*$/u);
  // The titles differ only in the package name near the end, so each one is shown in full.
  const titles = table()
    .getByTitle(/^Document the public API of @usine\//u)
    .elements();
  expect(titles).toHaveLength(6);
  for (const title of titles) expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
  // The canceled task's stall reason wraps beyond its first 20px line, next to its full title.
  const status = rowOf(/@usine\/github/u)
    .getByRole("cell")
    .nth(1)
    .element().firstElementChild;
  expect(status?.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
  const container = table().element().parentElement;
  expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
});

it("breaks a status word wider than the Status column inside it, beside the whole title", async () => {
  queryClient.setQueryData(overviewQuery().queryKey, boardOverviewDocumentedLongLoop());
  await mount(list);
  expect(columns()).toHaveLength(7);
  const row = rowOf(/@usine\/core/u);
  await expect.element(row).toMatchTextContent("Running dependency_updates");
  const [status, runs] = row.getByRole("cell").elements().slice(1, 3);
  const words = status?.firstElementChild;
  // `dependency_updates` wraps instead of overflowing into the Runs column.
  expect(words?.scrollWidth).toBeLessThanOrEqual(words?.clientWidth ?? 0);
  expect(words?.getBoundingClientRect().right).toBeLessThanOrEqual(
    runs?.getBoundingClientRect().left ?? 0,
  );
  const title = row.getByTitle("Document the public API of @usine/core in TSDoc").element();
  expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
});

it("drops Runs and Pull request beside the sidebar on a mid-size window", async () => {
  await mount(list, 1280);
  await expect
    .poll(columns)
    .toEqual(["Task", "Status", "Elapsed time", "Tokens", "Estimated cost"]);
  const title = rowOf(/Redesign the Board/u).getByRole("link", { name: /Redesign the Board/u });
  expect(title.element().getBoundingClientRect().width).toBeGreaterThan(240);
});

it("keeps only the elapsed time of the figures on a phone, without scrolling sideways", async () => {
  await mount(list, 390);
  await expect.poll(columns).toEqual(["Task", "Status", "Elapsed time"]);
  await expect
    .element(
      rowOf(/Show the salvage branch/u)
        .getByRole("cell")
        .nth(1),
    )
    .toMatchTextContent(/^Done · 1d ago$/u);
  // A long status wraps instead of shrinking the title.
  const title = rowOf(/Pin GitHub Actions/u).getByRole("link", { name: /Pin GitHub Actions/u });
  expect(title.element().getBoundingClientRect().width).toBeGreaterThan(100);
  const container = table().element().parentElement;
  expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
});
