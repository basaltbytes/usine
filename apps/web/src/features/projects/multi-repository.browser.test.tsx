import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { ItemKey } from "@usine/core/item";
import {
  BoardItemLink,
  BoardTaskView,
  BoardView,
  DeskView,
  FactoryOverview,
  ProjectView,
  ReadyOverview,
  RunView,
  WritableBoardLaneView,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { overviewQuery } from "~/lib/overview";
import { deskQuery } from "~/lib/desk/queries";
import { boardOverview } from "~/lib/projects/fixture";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const second = RepositoryName.make("board-test/api");
const overview = () => {
  const [project] = boardOverview().projects;
  const ready = project?.board.lanes.find(
    (lane) => lane._tag === "WritableBoardLane" && lane.items.some((item) => item.runs.length > 0),
  );
  const template = ready?.items.find((item) => item.runs.length > 0);
  if (project === undefined || ready === undefined || template === undefined)
    throw new Error("Missing board fixture");
  const itemKey = ItemKey.make(`${second}:${template.number}`);
  const card = new BoardTaskView({
    ...template,
    repository: second,
    itemKey,
    title: "API task",
    items: template.items.map(
      (item) =>
        new BoardItemLink({
          ...item,
          itemKey,
          title: "API task",
          url: `https://github.com/${second}/issues/${item.number}`,
        }),
    ),
    runs: template.runs.map(
      (run) =>
        new RunView({ ...run, repository: second, id: RunId.make(`api-${run.id}`), itemKey }),
    ),
    run: null,
    loops: [],
  });
  const combined = new ProjectView({
    ...project,
    id: ProjectId.make("product"),
    name: "Product",
    repositories: [project.repository, RepositoryName.make("Board-Test/API")],
    board: new BoardView({
      failures: [],
      lanes: project.board.lanes.map((lane) =>
        lane.id === ready.id && lane._tag === "WritableBoardLane"
          ? new WritableBoardLaneView({ ...lane, items: [template, card] })
          : lane,
      ),
    }),
  });
  return new ReadyOverview({ projects: [combined], loops: [], needsYou: [] });
};
beforeEach(() => {
  document.documentElement.classList.add("dark");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(overviewQuery().queryKey, overview());
  client.setQueryData(
    deskQuery().queryKey,
    new DeskView({ running: [], notMoving: [], lastOutcomes: [], workers: [], polls: [] }),
  );
});
afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  host.remove();
});
const mount = async (path: string, width: number) => {
  await commands.boardResponses(
    JSON.stringify(Schema.encodeSync(FactoryOverview)(overview())),
    200,
  );
  await page.viewport(width, 844);
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  return router;
};

it("shows both repositories, preserves the card repository when moving, and contains phone overflow", async () => {
  await mount("/projects/product", 390);
  const card = page.getByRole("link", { name: "API task", exact: true });
  await expect.element(card).toBeVisible();
  expect(card.element().getAttribute("href")).toContain("/projects/product/tasks/");
  expect(card.element().getAttribute("href")).toContain("repository=board-test%2Fapi");
  const container = card.element().closest('[class~="group/task"]');
  expect(container?.textContent).toContain(second);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  for (const theme of ["dark", "light"]) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    for (const [width, device] of [
      [1440, "desktop"],
      [390, "phone"],
    ] as const) {
      await page.viewport(width, 900);
      if (width === 1440)
        await expect
          .element(page.getByRole("link", { name: "Product", exact: true }).first())
          .toHaveAttribute("title", "2 repositories");
      await commands.configurationEditorScreenshot(`673-board-${device}-${theme}`);
    }
  }
  const trigger = container?.querySelector<HTMLButtonElement>("button[aria-label^='Actions for']");
  if (trigger === null || trigger === undefined) throw new Error("Missing card actions");
  trigger.click();
  await page.getByRole("menuitem", { name: "Move to", exact: true }).click();
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
  await expect.poll(async () => (await commands.boardMoveRequests()).length).toBe(1);
  expect((await commands.boardMoveRequests())[0]?.url).toContain(
    "/api/projects/board-test/api/items/",
  );
});

it("redirects a legacy URL for the second repository to its project", async () => {
  const router = await mount("/projects/board-test/api", 1440);
  await expect.poll(() => router.state.location.pathname).toBe("/projects/product");
  await expect.element(page.getByRole("heading", { name: "Product", exact: true })).toBeVisible();
});

it("filters the project task list by repository without changing the project", async () => {
  const router = await mount("/projects/product/tasks", 390);
  const card = page.getByRole("link", { name: /API task/u });
  await expect.element(card).toBeVisible();
  for (const theme of ["dark", "light"]) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    for (const [width, device] of [
      [1440, "desktop"],
      [390, "phone"],
    ] as const) {
      await page.viewport(width, 900);
      await commands.configurationEditorScreenshot(`673-tasks-${device}-${theme}`);
    }
  }
  await page
    .getByRole("combobox", { name: "Repository", exact: true })
    .selectOptions("board-test/repo");
  await expect.element(card).not.toBeInTheDocument();
  await page
    .getByRole("combobox", { name: "Repository", exact: true })
    .selectOptions("Board-Test/API");
  await expect.element(card).toBeVisible();
  expect(router.state.location.pathname).toBe("/projects/product/tasks");
  expect(router.state.location.search).toMatchObject({ repository: "Board-Test/API" });
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

it("redirects a legacy repository named tasks instead of treating its owner as a project", async () => {
  client.setQueryData(
    overviewQuery().queryKey,
    new ReadyOverview({
      ...overview(),
      projects: overview().projects.map(
        (project) =>
          new ProjectView({
            ...project,
            repositories: [...project.repositories, RepositoryName.make("board-test/tasks")],
          }),
      ),
    }),
  );
  const router = await mount("/projects/board-test/tasks", 1440);
  await expect.poll(() => router.state.location.pathname).toBe("/projects/product");
});

it.each(["tasks", "runs"])(
  "redirects the legacy task list for a repository named %s",
  async (name) => {
    const repository = RepositoryName.make(`board-test/${name}`);
    client.setQueryData(
      overviewQuery().queryKey,
      new ReadyOverview({
        ...overview(),
        projects: overview().projects.map(
          (project) =>
            new ProjectView({
              ...project,
              repositories: [...project.repositories, repository],
            }),
        ),
      }),
    );
    const router = await mount(`/projects/board-test/${name}/tasks`, 1440);
    await expect.poll(() => router.state.location.pathname).toBe("/projects/product/tasks");
    expect(router.state.location.search).toMatchObject({ repository });
    await expect
      .element(page.getByRole("combobox", { name: "Repository", exact: true }))
      .toHaveValue(repository);
  },
);
