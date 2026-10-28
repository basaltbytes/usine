import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { LaneName } from "@usine/config/board";
import { RepositoryName } from "@usine/core/repository";
import { ItemKey, ItemNumber } from "@usine/core/item";
import {
  DeskView,
  BoardItemLink,
  BoardLaneId,
  BoardTaskView,
  BoardView,
  ProjectView,
  ReadOnlyBoardLaneView,
  ReadyOverview,
} from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { overviewQuery } from "~/lib/overview";
import { deskQuery } from "~/lib/desk/queries";
import { routeTree } from "~/route-tree.gen";
import { boardOverview } from "~/lib/projects/fixture";
import "~/index.css";

const repository = RepositoryName.make("basaltbytes/usine");
const projectWith = (backlog: ReadonlyArray<BoardTaskView>) =>
  new ProjectView({
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
            items: name === "Backlog" ? backlog : [],
          }),
      ),
    }),
  });
const project = projectWith([]);

/** Returns `count` copies of a fixture card, each with its own Item. */
const manyTasks = (count: number): ReadonlyArray<BoardTaskView> => {
  const [template] = boardOverview().projects.flatMap(({ board }) =>
    board.lanes.flatMap(({ items }) => items),
  );
  if (template === undefined) throw new Error("The board fixture has no cards");
  return Array.from({ length: count }, (_, index) => {
    const number = ItemNumber.make(1000 + index);
    const itemKey = ItemKey.make(`${repository}:${number}`);
    const item = new BoardItemLink({
      itemKey,
      kind: template.kind,
      number,
      title: `Task ${number}`,
      url: template.url,
      state: template.state,
    });
    return new BoardTaskView({
      ...template,
      ...item,
      items: [item],
      runs: [],
      run: null,
      pullRequest: null,
    });
  });
};
let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(
    deskQuery().queryKey,
    new DeskView({ running: [], notMoving: [], lastOutcomes: [], workers: [], polls: [] }),
  );
  queryClient.setQueryData(
    overviewQuery().queryKey,
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
  // Scrolling the page horizontally must not move the first lane under the fixed navigation.
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

it("scrolls a long lane on its own and fades the edges that hide cards", async () => {
  queryClient.setQueryData(
    overviewQuery().queryKey,
    new ReadyOverview({ projects: [projectWith(manyTasks(30))], loops: [], needsYou: [] }),
  );
  await mountBoard(1024);
  const cards = page.getByLabelText("Backlog cards").element();
  const otherLane = lane("Ready").getBoundingClientRect().top;
  expect(cards.scrollHeight).toBeGreaterThan(cards.clientHeight);
  // The lane fits in the board, so the board itself doesn't scroll vertically.
  expect(board().scrollHeight).toBeLessThanOrEqual(board().clientHeight + 1);
  await expect.poll(() => cards.className).toContain("mask-b-from");
  expect(cards.className).not.toContain("mask-t-from");
  cards.scrollTop = cards.scrollHeight;
  await expect.poll(() => cards.className).toContain("mask-t-from");
  expect(cards.className).not.toContain("mask-b-from");
  expect(getComputedStyle(cards).maskImage).not.toBe("none");
  expect(lane("Ready").getBoundingClientRect().top).toBe(otherLane);
});
