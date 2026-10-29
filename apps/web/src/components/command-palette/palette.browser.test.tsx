import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { DeskView, ReadyOverview, ProjectView } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
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
    history: createMemoryHistory({ initialEntries: ["/projects/board-test/repo/tasks"] }),
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
  await search("board-test/repo board");
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
    .element(dialog().getByRole("option", { name: "board-test/repo · Board", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/board-test/repo");
  await search("board-test/repo tasks");
  await expect
    .element(dialog().getByRole("option", { name: "board-test/repo · Tasks", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/board-test/repo/tasks");
  await search("Configuration Loops");
  await expect
    .element(dialog().getByRole("option", { name: "Configuration · Loops", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/configuration/loops");
});

it("finds a task by a linked pull request number and opens its originating item", async () => {
  await search("#31");
  await dialog()
    .getByRole("option", { name: /Redesign the Board/u })
    .click();
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/board-test/repo/tasks/9");
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
    .toBe("/projects/board-test/repo/runs/run-redesign-plan");
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
  await search("board-test/repo board");
  await dialog().getByRole("option", { name: "board-test/repo · Board", exact: true }).click();
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/board-test/repo");
  await search("Open Done lane");
  await dialog().getByRole("option", { name: "Open Done lane", exact: true }).click();
  await search("Fold Done lane");
  await expect
    .element(dialog().getByRole("option", { name: "Fold Done lane", exact: true }))
    .toBeVisible();
  await dialog().getByRole("combobox").fill("board-test/repo tasks");
  await dialog().getByRole("option", { name: "board-test/repo · Tasks", exact: true }).click();
  await expect
    .poll(() => router.state.location.pathname, { timeout: 5_000 })
    .toBe("/projects/board-test/repo/tasks");
  await search("Done lane");
  await expect
    .element(dialog().getByRole("option", { name: "Fold Done lane", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(dialog().getByRole("option", { name: "Open Done lane", exact: true }))
    .not.toBeInTheDocument();
});
