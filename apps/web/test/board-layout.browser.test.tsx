import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { LaneName } from "@usine/config/board";
import { RepositoryName } from "@usine/core/repository";
import {
  BoardLaneId,
  BoardView,
  ProjectView,
  ReadOnlyBoardLaneView,
  ReadyOverview,
} from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { routeTree } from "../src/route-tree.gen.ts";
import "../src/index.css";

const repository = RepositoryName.make("basaltbytes/usine");
const project = new ProjectView({
  repository,
  status: "clear",
  runs: [],
  labels: [],
  preflightFindings: [],
  board: new BoardView({
    failures: [],
    lanes: ["Backlog", "Ready", "Developing", "Review", "Finishing", "Done"].map(
      (name) =>
        new ReadOnlyBoardLaneView({
          id: BoardLaneId.make(name),
          name: LaneName.make(name),
          origin: "authored",
          sources: [],
          items: [],
        }),
    ),
  }),
});
let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(
    ["overview"],
    new ReadyOverview({ projects: [project], loops: [], needsYou: [] }),
  );
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

const mountBoard = async (width: number) => {
  await page.viewport(width, 800);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/projects/basaltbytes/usine"] }),
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
  await expect.element(page.getByText("Backlog", { exact: true })).toBeVisible();
};

const lane = (name: string) => page.getByLabelText(`${name} lane`).element();
const board = () => page.getByLabelText(`${repository} project board`).element();
const expectLaneReachable = (name: string) => {
  const viewport = board().getBoundingClientRect();
  const bounds = lane(name).getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(viewport.left - 1);
  expect(bounds.right).toBeLessThanOrEqual(Math.min(viewport.right, window.innerWidth) + 1);
};
const visitBothEnds = async () => {
  const viewport = board();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  viewport.scrollLeft = viewport.scrollWidth;
  await expect.poll(() => viewport.scrollLeft).toBeGreaterThan(0);
  expectLaneReachable("Done");
  viewport.scrollLeft = 0;
  await expect.poll(() => viewport.scrollLeft).toBe(0);
  expectLaneReachable("Backlog");
};

it("keeps both Board ends reachable when the desktop sidebar is expanded and collapsed", async () => {
  await mountBoard(1024);
  // A page-level horizontal pan must not move the first lane under the fixed navigation.
  window.scrollTo({ left: board().getBoundingClientRect().left / 2, top: 0 });
  const navigation = page.getByRole("link", { name: "usine", exact: true });
  const navigationRight = navigation.element().getBoundingClientRect().right;
  expect(lane("Backlog").getBoundingClientRect().left).toBeGreaterThanOrEqual(navigationRight);
  await visitBothEnds();
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect
    .poll(() => navigation.element().getBoundingClientRect().right)
    .toBeLessThanOrEqual(0);
  await visitBothEnds();
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect
    .poll(() => navigation.element().getBoundingClientRect().right)
    .toBeCloseTo(navigationRight, 0);
  await visitBothEnds();
});

it("scrolls every lane inside a narrow viewport without moving the page beneath navigation", async () => {
  await mountBoard(390);
  await visitBothEnds();
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect.element(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog", { name: "Sidebar" })).not.toBeInTheDocument();
  await visitBothEnds();
});
