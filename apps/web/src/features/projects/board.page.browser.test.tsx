import { projectQuery } from "~/features/projects/queries";
import { projectId } from "~/lib/overview";
import { administratorPermissions } from "@usine/core/access";
import { PermissionsContext, sessionQuery } from "~/lib/permissions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { Schema } from "effect";
import { StateLaneSource, LaneName } from "@usine/config/board";
import { RepositoryName } from "@usine/core/repository";
import { ItemKey, ItemNumber } from "@usine/core/item";
import {
  boardRunSummary,
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
import { overviewQuery, attentionQuery } from "~/lib/overview";
import { deskQuery } from "~/lib/desk/queries";
import { routeTree } from "~/route-tree.gen";
import { boardOverview } from "~/lib/projects/fixture";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { invalidateChanges } from "~/lib/changes";
import "~/index.css";

const repository = RepositoryName.make("basaltbytes/usine");
const projectWith = (backlog: ReadonlyArray<BoardTaskView>) =>
  ProjectView.make({
    repository,
    status: "clear",
    runs: [],
    labels: [],
    preflightFindings: [],
    board: BoardView.make({
      failures: [],
      lanes: ["Backlog", "Ready", "Developing", "Review", "Finishing", "Done"].map((name) =>
        ReadOnlyBoardLaneView.make({
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
    const item = BoardItemLink.make({
      itemKey,
      kind: template.kind,
      number,
      title: `Task ${number}`,
      url: template.url,
      state: template.state,
    });
    return BoardTaskView.make({
      ...template,
      ...item,
      items: [item],
      ...boardRunSummary([], null, [item]),
      run: null,
      pullRequest: null,
    });
  });
};
const browserFetch = globalThis.fetch;
let respond: typeof globalThis.fetch = browserFetch;
globalThis.fetch = (...args) => respond(...args);

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(
    deskQuery().queryKey,
    DeskView.make({ running: [], notMoving: [], lastOutcomes: [], workers: [], polls: [] }),
  );
  queryClient.setQueryData(
    overviewQuery().queryKey,
    ReadyOverview.make({ projects: [project], loops: [], needsYou: [] }),
  );
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

const mountBoard = async (width: number) => {
  await page.viewport(width, 800);
  queryClient.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
  const view = queryClient.getQueryData(overviewQuery().queryKey)?.projects[0];
  if (view !== undefined) queryClient.setQueryData(projectQuery(projectId(view)).queryKey, view);
  queryClient.setQueryData(
    attentionQuery().queryKey,
    queryClient.getQueryData(overviewQuery().queryKey),
  );
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/projects/basaltbytes/usine"] }),
    context: { queryClient },
  });
  await router.load();
  flushSync(() =>
    root.render(
      <PermissionsContext.Provider value={administratorPermissions}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </PermissionsContext.Provider>,
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
    ReadyOverview.make({ projects: [projectWith(manyTasks(30))], loops: [], needsYou: [] }),
  );
  await mountBoard(1024);
  await expect.element(page.getByLabelText("Last updated", { exact: true })).toBeVisible();
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

it.each([404, 503])(
  "shows Project not found only for a removed board (HTTP %s)",
  async (status) => {
    await mountBoard(1024);
    const originalFetch = respond;
    respond = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!url.pathname.startsWith("/api/projects/")) return originalFetch(input, init);
      return new Response(
        JSON.stringify({
          error: status === 404 ? "BoardProjectNotFoundError" : "BackendUnavailableError",
          message: status === 404 ? "Project removed" : "Temporarily unavailable",
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    };
    try {
      await invalidateChanges(
        queryClient,
        ChangeNotice.make({
          revision: 1,
          reset: false,
          changes: [{ kind: "project", id: projectId(project) }],
        }),
      );
      if (status === 404) {
        await expect.element(page.getByText("Project not found", { exact: true })).toBeVisible();
        await expect
          .element(
            page.getByText(
              `No project has the ID ${projectId(project)}. Admins manage projects in Configuration > Projects.`,
              { exact: true },
            ),
          )
          .toBeVisible();
        await expect
          .element(page.getByLabelText(`${repository} project board`))
          .not.toBeInTheDocument();
      } else {
        await expect.element(page.getByLabelText(`${repository} project board`)).toBeVisible();
        await expect
          .element(page.getByText("Project not found", { exact: true }))
          .not.toBeInTheDocument();
      }
    } finally {
      respond = originalFetch;
    }
  },
);

it("loads every Done card as the virtual lane scrolls", async () => {
  const cards = manyTasks(120);
  const done = ReadOnlyBoardLaneView.make({
    id: BoardLaneId.make("Done"),
    name: LaneName.make("Done"),
    origin: "authored",
    sources: [StateLaneSource.make({ state: "issue-closed" })],
    items: [],
    totalItems: cards.length,
  });
  const view = ProjectView.make({
    ...project,
    board: BoardView.make({
      failures: [],
      lanes: [...project.board.lanes.filter(({ name }) => name !== "Done"), done],
    }),
  });
  queryClient.setQueryData(
    overviewQuery().queryKey,
    ReadyOverview.make({ projects: [view], loops: [], needsYou: [] }),
  );
  const offsets: number[] = [];
  const originalFetch = respond;
  respond = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!url.pathname.endsWith("/lanes/Done/items")) return originalFetch(input, init);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    offsets.push(offset);
    const items = cards.slice(offset, offset + 50);
    return new Response(
      JSON.stringify({
        items: Schema.encodeSync(Schema.Array(BoardTaskView))(items),
        total: cards.length,
        nextOffset: offset + items.length < cards.length ? offset + items.length : null,
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    await mountBoard(1024);
    const viewport = board();
    viewport.scrollLeft = viewport.scrollWidth;
    await page.getByTitle("Open Done", { exact: true }).click();
    await expect.element(page.getByRole("link", { name: "Task 1000", exact: true })).toBeVisible();
    const scroller = page.getByLabelText("Done cards").element();
    for (const offset of [50, 100]) {
      scroller.scrollTop = scroller.scrollHeight;
      await expect
        .poll(
          () => {
            scroller.scrollTop = scroller.scrollHeight;
            return offsets.includes(offset);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    }
    await expect
      .poll(() => {
        scroller.scrollTop = scroller.scrollHeight;
        return scroller.textContent;
      })
      .toContain("Task 1119");
    await expect.element(page.getByRole("link", { name: "Task 1119", exact: true })).toBeVisible();
    expect(scroller.querySelectorAll("h3").length).toBeLessThan(50);
    expect(offsets).toEqual([0, 50, 100]);
  } finally {
    respond = originalFetch;
  }
});
