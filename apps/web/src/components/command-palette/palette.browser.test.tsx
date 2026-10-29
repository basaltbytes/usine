import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { DeskView, ReadyOverview, ProjectView, RunDetailView } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { ProjectId } from "@usine/core/project";
import { RunId } from "@usine/core/run";
import { runDetailQuery } from "~/lib/runs/queries";
import { RepositoryName } from "@usine/core/repository";
import { overviewQuery } from "~/lib/overview";
import { deskQuery } from "~/lib/desk/queries";
import { configurationQuery } from "~/lib/configuration/queries";
import { configurationFixture } from "~/lib/configuration/fixture";
import { boardOverview, boardStalled } from "~/lib/projects/fixture";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let router: ReturnType<typeof createRouter>;

// Navigation to an uncached detail still resolves its URL and displays the server's refusal.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ error: "BoardItemNotFoundError", message: "No task" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

beforeEach(async () => {
  await commands.taskListAvatarResponse();
  document.documentElement.classList.add("dark");
  await page.viewport(1440, 900);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const overview = boardOverview();
  client.setQueryData(
    overviewQuery().queryKey,
    new ReadyOverview({
      ...overview,
      projects: overview.projects.map(
        (project) =>
          new ProjectView({
            ...project,
            id: ProjectId.make("product"),
            name: "Product",
            repository: RepositoryName.make("board-test/primary"),
            repositories: [RepositoryName.make("board-test/primary"), project.repository],
            runs: project.board.lanes.flatMap(({ items }) => items.flatMap(({ runs }) => runs)),
          }),
      ),
    }),
  );
  client.setQueryData(
    deskQuery().queryKey,
    new DeskView({
      running: [],
      notMoving: boardStalled(),
      lastOutcomes: [],
      workers: [],
      polls: [],
    }),
  );
  client.setQueryData(configurationQuery().queryKey, configurationFixture());
  router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: ["/projects/product/tasks"] }),
  });
  await router.load();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await expect.element(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
});
afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  host.remove();
});
const dialog = () => page.getByRole("dialog", { name: "Commands", exact: true });
const search = async (text: string) => {
  await page.getByRole("button", { name: "Open commands", exact: true }).click();
  await dialog().getByRole("combobox").fill(text);
};

it("navigates to project boards, task lists, and configuration pages with keyboard selection", async () => {
  await page.screenshot({ path: "../../../../../.impeccable/review/operator-count-refresh.png" });
  await search("Product board");
  await expect
    .poll(
      () =>
        dialog()
          .element()
          .getAnimations()
          .filter((animation) => animation.playState === "running").length,
    )
    .toBe(0);
  await page.screenshot({ path: "../../../../../.impeccable/review/commands-desktop.png" });
  await expect
    .element(dialog().getByRole("option", { name: "Product · Board", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/product");
  await search("Product tasks");
  await expect
    .element(dialog().getByRole("option", { name: "Product · Tasks", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/product/tasks");
  await search("Configuration Loops");
  await expect
    .element(dialog().getByRole("option", { name: "Configuration · Loops", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/configuration/loops");
});

it("finds a secondary repository task by a linked pull request and preserves its repository", async () => {
  await search("#31");
  await dialog()
    .getByRole("option", { name: /Redesign the Board/u })
    .click();
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/product/tasks/9");
  expect(router.state.location.search).toMatchObject({ repository: "board-test/repo" });
});

it("finds related runs by item number and can select a run by its identifier", async () => {
  await search("#9");
  await expect
    .element(dialog().getByRole("option", { name: /Run run-rede · implement/u }))
    .toBeVisible();
  await dialog().getByRole("combobox").fill("run-redesign-plan");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => router.state.location.pathname)
    .toBe("/projects/product/runs/run-redesign-plan");
});

it("shows no-results feedback and keeps the palette within a phone viewport", async () => {
  await page.viewport(390, 844);
  await search("board-test/repo");
  await expect
    .poll(
      () =>
        dialog()
          .element()
          .getAnimations()
          .filter((animation) => animation.playState === "running").length,
    )
    .toBe(0);
  await page.screenshot({ path: "../../../../../.impeccable/review/commands-mobile.png" });
  await dialog().getByRole("combobox").fill("no-such-command");
  await expect.element(dialog().getByText("No matching commands", { exact: true })).toBeVisible();
  const bounds = dialog().element().getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  expect(dialog().element().scrollWidth).toBeLessThanOrEqual(dialog().element().clientWidth);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("button", { name: "Open commands" })).toHaveFocus();
});

it("removes board commands after navigation and changes the available fold action", async () => {
  await search("Product board");
  await dialog().getByRole("option", { name: "Product · Board", exact: true }).click();
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/product");
  await search("Open Done lane");
  await dialog().getByRole("option", { name: "Open Done lane", exact: true }).click();
  await search("Fold Done lane");
  await expect
    .element(dialog().getByRole("option", { name: "Fold Done lane", exact: true }))
    .toBeVisible();
  await dialog().getByRole("combobox").fill("board-test/repo tasks");
  await dialog().getByRole("option", { name: "Product · Tasks", exact: true }).click();
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/product/tasks");
  await search("Done lane");
  await expect
    .element(dialog().getByRole("option", { name: "Fold Done lane", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(dialog().getByRole("option", { name: "Open Done lane", exact: true }))
    .not.toBeInTheDocument();
});

it("uses drawer actions while open and restores the underlying page commands after closing", async () => {
  await router.navigate({
    to: "/projects/$project",
    params: { project: ProjectId.make("product") },
  });
  const run = boardOverview()
    .projects.flatMap(({ board }) =>
      board.lanes.flatMap(({ items }) => items.flatMap(({ runs }) => runs)),
    )
    .find(({ id }) => id === "run-salvage");
  if (run === undefined) throw new Error("Missing waiting run fixture");
  client.setQueryData(
    runDetailQuery(client, run.id).queryKey,
    new RunDetailView({
      run,
      agentDefinitionChanged: false,
      eventDedupKey: "event",
      eventPayload: {},
      transcript: [],
      sessionState: [],
      earlierTranscript: [],
    }),
  );
  await router.navigate({ to: ".", search: { run: RunId.make("run-salvage") } });
  await expect.element(page.getByRole("dialog", { name: /Retry salvage pushes/u })).toBeVisible();
  await userEvent.keyboard("{Control>}k{/Control}");
  await dialog().getByRole("combobox").fill("Approve");
  await expect
    .element(dialog().getByRole("option", { name: "Approve · run-salvage", exact: true }))
    .toBeVisible();
  await dialog().getByRole("combobox").fill("Done lane");
  await expect
    .element(dialog().getByRole("option", { name: "Open Done lane", exact: true }))
    .not.toBeInTheDocument();
  await dialog().getByRole("combobox").fill("Cancel run-salvage");
  await dialog().getByRole("option", { name: "Cancel run · run-salvage", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Confirm cancel", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Keep running", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await search("Done lane");
  await expect
    .element(dialog().getByRole("option", { name: "Open Done lane", exact: true }))
    .toBeVisible();
  await dialog().getByRole("combobox").fill("Approve run-salvage");
  await expect
    .element(dialog().getByRole("option", { name: "Approve · run-salvage", exact: true }))
    .not.toBeInTheDocument();
});
