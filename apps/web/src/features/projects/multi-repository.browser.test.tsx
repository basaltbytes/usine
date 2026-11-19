import { projectQuery } from "~/features/projects/queries";
import { projectTasksQuery } from "~/features/tasks/queries";
import { administratorPermissions } from "@usine/core/access";
import { PermissionsContext, sessionQuery } from "~/lib/permissions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { ItemKey } from "@usine/core/item";
import { AttemptTask } from "@usine/core/attempt";
import {
  AttemptView,
  boardTaskRuns,
  boardRunSummary,
  BoardItemLink,
  BoardTaskView,
  BoardView,
  DeskView,
  FactoryOverview,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunSummaryView,
  RunView,
  WritableBoardLaneView,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { overviewQuery, attentionQuery, projectId } from "~/lib/overview";
import { deskQuery } from "~/lib/desk/queries";
import { runDetailQuery } from "~/lib/runs/queries";
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
    (lane) =>
      lane._tag === "WritableBoardLane" &&
      lane.items.some((item) => boardTaskRuns(item).length > 0),
  );
  const template = ready?.items.find((item) => boardTaskRuns(item).length > 0);
  if (project === undefined || ready === undefined || template === undefined)
    throw new Error("Missing board fixture");
  const itemKey = ItemKey.make(`${second}:${template.number}`);
  const items = template.items.map((item) =>
    BoardItemLink.make({
      ...item,
      itemKey,
      title: "API task",
      url: `https://github.com/${second}/issues/${item.number}`,
    }),
  );
  const card = BoardTaskView.make({
    ...template,
    repository: second,
    itemKey,
    title: "API task",
    items,
    ...boardRunSummary(
      boardTaskRuns(template).map((run) =>
        RunSummaryView.make({
          ...run,
          repository: second,
          id: RunId.make(`api-${run.id}`),
          itemKey,
        }),
      ),
      null,
      items,
    ),
    run: null,
    loops: [],
  });
  const combined = ProjectView.make({
    ...project,
    id: ProjectId.make("product"),
    name: "Product",
    repositories: [project.repository, RepositoryName.make("Board-Test/API")],
    board: BoardView.make({
      failures: [],
      lanes: project.board.lanes.map((lane) =>
        lane.id === ready.id && lane._tag === "WritableBoardLane"
          ? WritableBoardLaneView.make({ ...lane, items: [template, card] })
          : lane,
      ),
    }),
  });
  return ReadyOverview.make({ projects: [combined], loops: [], needsYou: [] });
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
    DeskView.make({ running: [], notMoving: [], lastOutcomes: [], workers: [], polls: [] }),
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
  client.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  const cachedOverview = client.getQueryData(overviewQuery().queryKey);
  if (cachedOverview !== undefined) client.setQueryData(attentionQuery().queryKey, cachedOverview);
  for (const project of cachedOverview?.projects ?? []) {
    client.setQueryData(projectQuery(projectId(project)).queryKey, project);
    client.setQueryData(projectTasksQuery(projectId(project)).queryKey, project);
  }
  await router.load();
  flushSync(() =>
    root.render(
      <PermissionsContext.Provider value={administratorPermissions}>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </PermissionsContext.Provider>,
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

it("names the repository of a legacy URL that no project includes", async () => {
  await mount("/projects/acme/widget", 1440);
  await expect.element(page.getByText("Project not found", { exact: true })).toBeVisible();
  await expect
    .element(
      page.getByText(
        "No project includes the repository acme/widget. Admins manage projects in Configuration > Projects.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect.element(page.getByText(/No project has the ID/u)).not.toBeInTheDocument();
});

it("says a run belongs to another project instead of calling the URL project missing", async () => {
  const run = overview()
    .projects.flatMap(({ board }) =>
      board.lanes.flatMap(({ items }) => items.flatMap(boardTaskRuns)),
    )
    .find(({ repository }) => repository === RepositoryName.make("board-test/repo"));
  if (run === undefined) throw new Error("Missing run fixture");
  client.setQueryData(
    runDetailQuery(client, run.id).queryKey,
    RunDetailView.make({
      run: RunView.make({
        ...run,
        task: "Implement the issue.",
        resultMessage: null,
        attempts: run.attempts.map((attempt) =>
          AttemptView.make({ ...attempt, task: AttemptTask.make("Implement the issue.") }),
        ),
      }),
      agentDefinitionChanged: false,
      eventDedupKey: "event",
      eventPayload: {},
      transcript: [],
      sessionState: [],
      earlierTranscript: [],
    }),
  );
  await mount(`/projects/other/runs/${run.id}`, 1440);
  await expect.element(page.getByText("Run not found", { exact: true })).toBeVisible();
  await expect
    .element(
      page.getByText(
        `Run ${run.id} does not belong to the project other. Admins manage projects in Configuration > Projects.`,
        { exact: true },
      ),
    )
    .toBeVisible();
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

it("clears a repository filter whose URL casing differs from project membership", async () => {
  const router = await mount("/projects/product/tasks?repository=board-test%2Fapi", 390);
  const filter = page.getByRole("combobox", { name: "Repository", exact: true });
  const apiTask = page.getByRole("link", { name: /API task/u });
  const otherTask = page.getByRole("link", { name: /Redesign the Board columns and cards/u });
  await expect.element(filter).toHaveValue("Board-Test/API");
  await expect.element(apiTask).toBeVisible();
  await expect.element(otherTask).not.toBeInTheDocument();

  await filter.selectOptions("");

  await expect.element(filter).toHaveValue("");
  await expect.poll(() => router.state.location.search.repository).toBeUndefined();
  expect(router.state.location.searchStr).not.toContain("repository=");
  expect(router.state.location.pathname).toBe("/projects/product/tasks");
  await expect.element(apiTask).toBeVisible();
  await expect.element(otherTask).toBeVisible();
});

it("redirects a legacy repository named tasks instead of treating its owner as a project", async () => {
  client.setQueryData(
    overviewQuery().queryKey,
    ReadyOverview.make({
      ...overview(),
      projects: overview().projects.map((project) =>
        ProjectView.make({
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
      ReadyOverview.make({
        ...overview(),
        projects: overview().projects.map((project) =>
          ProjectView.make({
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
