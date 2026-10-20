import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { DeskView } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { routeTree } from "../src/route-tree.gen.ts";
import { boardOverview, boardStalled } from "./board-fixture.ts";
import "../src/index.css";

const list = "/projects/board-test/repo/tasks";

// A Task page asks for its Task; this stand-in server knows none, so only the address matters.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ error: "BoardItemNotFoundError", message: "No Task" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

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
  queryClient.setQueryData(
    ["desk"],
    new DeskView({
      running: [],
      notMoving: boardStalled(),
      lastOutcomes: [],
      workers: [],
      polls: [],
    }),
  );
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

const mount = async (path: string, width = 1280) => {
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
const doneToggle = () => page.getByRole("button", { name: "Done 1", exact: true });
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

it("lists the open tasks with their state, loops, runs, last run, and pull request", async () => {
  await mount(list);
  await expect.element(page.getByText("9 open, 1 done", { exact: true })).toBeVisible();
  expect(columns()).toEqual(["Task", "State", "Loops", "Runs", "Last run", "Pull request"]);
  // A heading row and the nine open tasks; the task with the merged pull request is done.
  await expect.poll(() => table().getByRole("row").elements().length).toBe(10);
  await expect.element(rowOf(/^#44/u)).toBe(table().getByRole("row").nth(1).element());
  expect(rowOf(/Show the salvage branch/u).elements()).toHaveLength(0);

  const redesign = rowOf(/Redesign the Board columns/u);
  await expect.element(redesign).toHaveTextContent("#31");
  await expect.element(redesign).toHaveTextContent("OpenIn progress");
  await expect.element(redesign).toHaveTextContent("plan, implement");
  await expect.element(redesign).toHaveTextContent(/implementRunning6m ago/u);
  await expect
    .element(redesign.getByRole("link", { name: "#31", exact: true }))
    .toHaveAttribute("href", "https://github.com/board-test/repo/pull/31");
  // The stall reason reads as on Overview and the Board card.
  await expect
    .element(rowOf(/Pin GitHub Actions/u))
    .toHaveTextContent(/reviewFailed1h ago\s*Failed 1h ago: Agent failure/u);
  await expect
    .element(rowOf(/Retry salvage pushes/u))
    .toHaveTextContent(/implementWaiting3m agoWaiting for approval/u);
});

it("adds the done tasks with the Done toggle and keeps it in the address", async () => {
  await mount(list);
  await expect.element(doneToggle()).toHaveAttribute("aria-pressed", "false");
  await doneToggle().click();
  await expect.element(doneToggle()).toHaveAttribute("aria-pressed", "true");
  expect(router.state.location.searchStr).toBe("?done=1");
  const shipped = rowOf(/Show the salvage branch/u);
  await expect.element(shipped).toHaveTextContent("MergedDone");
  await expect.element(shipped).toHaveTextContent(/#6\s*Merged$/u);

  // Leaving for a task page and coming back keeps the done tasks.
  await rowOf(/Redesign the Board columns/u)
    .getByRole("link", { name: /Redesign/u })
    .click();
  await expect.poll(() => router.state.location.pathname).toBe(`${list}/9`);
  router.history.back();
  await expect.element(doneToggle()).toHaveAttribute("aria-pressed", "true");
  await expect.element(rowOf(/Show the salvage branch/u)).toBeVisible();

  await doneToggle().click();
  await expect.element(doneToggle()).toHaveAttribute("aria-pressed", "false");
  expect(router.state.location.searchStr).toBe("");
});

it("opens the task page from anywhere on a row, under its originating item", async () => {
  await mount(list);
  // A click on the Runs cell, which holds no link of its own, opens the task page too.
  const row = rowOf(/Redesign the Board columns/u);
  const runs = row.getByRole("cell").nth(3).element().getBoundingClientRect();
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

it("drops Loops and Pull request on a phone and folds the rest under the title", async () => {
  await mount(list, 390);
  await expect.poll(columns).toEqual(["Task", "Runs"]);
  // State and the last run fold under the title.
  await expect
    .element(
      rowOf(/Pin GitHub Actions/u)
        .getByRole("cell")
        .first(),
    )
    .toHaveTextContent(/OpenReviewreviewFailed1h ago\s*Failed 1h ago: Agent failure/u);
  const container = table().element().parentElement;
  expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
});
