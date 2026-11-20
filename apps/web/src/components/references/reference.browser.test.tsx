import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { TurnSource } from "@usine/core/conversation";
import { ProjectId } from "@usine/core/project";
import { CommitSha } from "@usine/core/repository";
import {
  BoardItemLink,
  boardRunSummary,
  BoardTaskView,
  boardTaskRuns,
  DeskView,
  RunFailedView,
  StalledItemView,
} from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, assert, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { Markdown } from "~/components/markdown";
import { ReferenceScopeContext } from "~/components/references/scope";
import { TextTooltipProvider } from "~/components/text-tooltip";
import { Status } from "~/features/tasks/components/list/status";
import { configurationFixture } from "~/lib/configuration/fixture";
import { configurationQuery } from "~/lib/configuration/queries";
import { deskQuery } from "~/lib/desk/queries";
import { overviewQuery } from "~/lib/overview";
import { changeTasks } from "~/lib/projects/fixture";
import type { ReferenceScope } from "~/lib/references/resolve";
import { taskRows } from "~/lib/tasks/model";
import { statusLine } from "~/lib/tasks/status";
import { projectTasksQuery } from "~/lib/tasks/queries";
import { taskOverview, taskRepository } from "~/lib/tasks/fixture";
import { routeTree } from "~/route-tree.gen";

const project = ProjectId.make("basaltbytes-usine");
const revision = CommitSha.make("0123456789abcdef0123456789abcdef01234567");
const scope: ReferenceScope = {
  project,
  repository: undefined,
  sources: [TurnSource.make({ repository: taskRepository, revision })],
};
const emptyDesk = DeskView.make({
  running: [],
  notMoving: [],
  lastOutcomes: [],
  workers: [],
  polls: [],
});

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

const board = (overview = taskOverview()) => {
  const [view] = overview.projects;
  assert(view !== undefined);
  return view;
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(overviewQuery().queryKey, taskOverview());
  queryClient.setQueryData(projectTasksQuery(project).queryKey, board());
  queryClient.setQueryData(deskQuery().queryKey, emptyDesk);
  queryClient.setQueryData(configurationQuery().queryKey, configurationFixture());
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

/** Renders `markdown` in `within`, or outside any reference scope for `null`. */
const render = (markdown: string, within: ReferenceScope | null = scope) => {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/conversations"] }),
    context: { queryClient },
  });
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterContextProvider router={router}>
          <TextTooltipProvider>
            {within === null ? (
              <Markdown>{markdown}</Markdown>
            ) : (
              <ReferenceScopeContext value={within}>
                <Markdown>{markdown}</Markdown>
              </ReferenceScopeContext>
            )}
          </TextTooltipProvider>
        </RouterContextProvider>
      </QueryClientProvider>,
    ),
  );
  return router;
};

const link = (name: RegExp | string) => page.getByRole("link", { name });

it("shows a task on the board as a chip that opens its task page", async () => {
  render("Task #42 waits on review.");
  const chip = link(/Rework the conversation reader/u);
  await expect
    .element(chip)
    .toHaveAttribute("href", "/projects/basaltbytes-usine/tasks/40?repository=basaltbytes%2Fusine");
  expect(chip.element().textContent).toContain("Running fix-ci");
  expect(chip.element().getAttribute("target")).toBeNull();
  await expect.element(chip.getByRole("img", { name: "Issue #40, open" })).toBeVisible();
});

/** Returns the board where #42's failed start-dev run, which the desk lists as stalled, is its status. */
const stalledBoard = () => {
  const view = board(
    changeTasks(taskOverview(), (task) =>
      task.number === 42
        ? BoardTaskView.make({
            ...task,
            ...boardRunSummary(
              boardTaskRuns(task).filter(({ state }) => state !== "Running" && state !== "Waiting"),
              null,
              task.items,
            ),
          })
        : task,
    ),
  );
  const task = view.board.lanes.flatMap(({ items }) => items).find(({ number }) => number === 42);
  const failed = task === undefined ? undefined : boardTaskRuns(task).find(isFailed);
  const item = task?.items[0];
  assert(failed !== undefined && item !== undefined);
  const stall = StalledItemView.make({
    repository: failed.repository,
    loop: failed.loop,
    item,
    reason: RunFailedView.make({ run: failed }),
  });
  return { view, desk: DeskView.make({ ...emptyDesk, notMoving: [stall] }) };
};

const isFailed = ({ state }: { readonly state: string }) => state === "Failed";

it("gives a task the mark, tone, and status that the Tasks list gives it, stalls included", async () => {
  for (const { view, desk, expected } of [
    { view: board(), desk: emptyDesk, expected: "text-run-active" },
    { ...stalledBoard(), expected: "text-run-failed" },
  ]) {
    queryClient.setQueryData(projectTasksQuery(project).queryKey, view);
    queryClient.setQueryData(deskQuery().queryKey, desk);
    const [row] = taskRows(view.board.lanes, desk.notMoving);
    assert(row !== undefined);
    render("See #40.");
    const chip = link(/Rework the conversation reader/u);
    await expect.element(chip).toBeVisible();
    const listed = document.createElement("div");
    document.body.append(listed);
    const listRoot = createRoot(listed);
    flushSync(() => listRoot.render(<Status row={row} now={Date.now()} />));
    const tone = (mark: Element | null | undefined) =>
      [...(mark?.classList ?? [])].filter((name) => name.startsWith("text-"));
    try {
      await expect
        .poll(() => tone(chip.element().querySelector("[data-slot=state-mark]")))
        .toEqual([expected]);
      expect(tone(listed.querySelector("[data-slot=state-mark]"))).toEqual([expected]);
      const { words } = statusLine(row, Date.now());
      expect(listed.textContent).toContain(words);
      expect(chip.element().textContent).toContain(words);
    } finally {
      flushSync(() => listRoot.unmount());
      listed.remove();
    }
  }
});

it("updates a task's chip when the board changes, without a reload", async () => {
  render("See #40.");
  await expect.element(page.getByRole("img", { name: "Issue #40, open" })).toBeVisible();
  const closed = changeTasks(taskOverview(), (task) =>
    BoardTaskView.make({
      ...task,
      items: task.items.map((item) =>
        item.number === 40 ? BoardItemLink.make({ ...item, state: "issue-closed" }) : item,
      ),
    }),
  );
  queryClient.setQueryData(projectTasksQuery(project).queryKey, board(closed));
  await expect.element(page.getByRole("img", { name: "Issue #40, closed" })).toBeVisible();
});

it("links a number that isn't a task to GitHub, and keeps a task the member can't read as text", async () => {
  render("Neither #999 nor acme/app#3 is on the board.");
  await expect
    .element(link("#999"))
    .toHaveAttribute("href", "https://github.com/basaltbytes/usine/issues/999");
  expect(link("#999").element().getAttribute("target")).toBe("_blank");
  expect(host.querySelectorAll("a")).toHaveLength(1);
  expect(host.textContent).toContain("acme/app#3");
  // A project the member can't read has no view: its read fails.
  const hidden = ProjectId.make("hidden");
  queryClient.setQueryDefaults(projectTasksQuery(hidden).queryKey, { enabled: false });
  render("See #40.", { ...scope, project: hidden });
  await expect.element(page.getByText("See #40.")).toBeVisible();
  expect(host.querySelectorAll("a")).toHaveLength(0);
});

it("links a run ID that the board doesn't show to its run page", async () => {
  const closed = "0f3c9a1b2d4e5f60718293a4b5c6d7e8";
  render(`Run ${closed} failed last week, and \`${closed}\` is the same run.`);
  const runs = link(closed);
  await expect.poll(() => runs.elements().length).toBe(2);
  for (const run of runs.elements()) {
    expect(run.getAttribute("href")).toBe(`/projects/basaltbytes-usine/runs/${closed}`);
    expect(run.getAttribute("target")).toBeNull();
  }
});

it("keeps references inside code blocks and links as written", async () => {
  render(["```", "#40 run-again review-pr", "```", "", "[#40](https://example.com/x)"].join("\n"));
  await expect.element(link("#40")).toHaveAttribute("href", "https://example.com/x");
  expect(host.querySelectorAll("a")).toHaveLength(1);
  expect(host.querySelector("pre")?.textContent).toContain("#40 run-again review-pr");
});

it("shows runs, labels, and configuration names in code spans", async () => {
  render("`run-again` on `review-pr` with `developer` on `eu-1`, labelled `ready-for-review`.");
  const run = link(/fix-ci/u);
  await expect.element(run).toHaveAttribute("href", "/projects/basaltbytes-usine/runs/run-again");
  expect(run.element().textContent).toContain("Running");
  await expect.element(link("review-pr")).toHaveAttribute("href", "/configuration/loops/review-pr");
  await expect
    .element(link("developer"))
    .toHaveAttribute("href", "/configuration/agents/developer");
  await expect.element(link("eu-1")).toHaveAttribute("href", "/configuration/workers/eu-1");
  expect(page.getByText("ready-for-review").element().closest("a")).toBeNull();
});

it("links a source line under a mounted repository, and keeps one outside as code", async () => {
  render(
    "Read `basaltbytes/usine/packages/core/src/conversation.ts:36` and not `acme/app/src/a.ts:3`.",
  );
  await expect
    .element(link("basaltbytes/usine/packages/core/src/conversation.ts:36"))
    .toHaveAttribute(
      "href",
      `https://github.com/basaltbytes/usine/blob/${revision}/packages/core/src/conversation.ts#L36`,
    );
  expect(page.getByText("acme/app/src/a.ts:3").element().tagName).toBe("CODE");
  expect(host.querySelectorAll("a")).toHaveLength(1);
});

it("leaves references as text outside a reference scope", async () => {
  render("See #40 and `review-pr`.", null);
  await expect.element(page.getByText("review-pr")).toBeVisible();
  expect(host.querySelectorAll("a")).toHaveLength(0);
});
