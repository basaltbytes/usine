import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  BoardTaskView,
  BoardView,
  FactoryOverview,
  MachineQuotaWait,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunView,
  StatisticsView,
  RunStatisticsView,
  WorkerQuotaNeed,
  WritableBoardLaneView,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { boardOverview } from "~/lib/projects/fixture";
import { emptyStatisticsFixture, emptyRunStatisticsFixture } from "~/lib/desk/fixture";
import { needCopy } from "~/lib/needs-you/strings";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

const fixture = () => {
  const [project] = boardOverview().projects;
  const lane = project?.board.lanes.find(
    (candidate) => candidate._tag === "WritableBoardLane" && candidate.name === "Ready",
  );
  const template = lane?.items[0];
  const previousRun = template?.runs[0];
  if (
    project === undefined ||
    lane?._tag !== "WritableBoardLane" ||
    template === undefined ||
    previousRun === undefined
  )
    throw new Error("Missing ready board fixture");
  const need = new WorkerQuotaNeed({
    id: "worker-quota:hetzner-pool",
    worker: WorkerName.make("hetzner-pool"),
    message:
      "Hetzner refused machine creation: status 403 resource_limit_exceeded: shared core limit exceeded.",
  });
  const run = new RunView({
    ...previousRun,
    id: RunId.make("approval-run"),
    state: "Running",
    canApprove: false,
    machineWait: new MachineQuotaWait({ worker: need.worker, message: need.message }),
  });
  const card = new BoardTaskView({ ...template, runs: [run], run, needsYou: false });
  const overview = new ReadyOverview({
    projects: [
      new ProjectView({
        ...project,
        runs: [run],
        board: new BoardView({
          lanes: [new WritableBoardLaneView({ ...lane, items: [card] })],
          failures: [],
        }),
      }),
    ],
    loops: [],
    needsYou: [need],
  });
  const detail = new RunDetailView({
    run,
    agentDefinitionChanged: false,
    eventDedupKey: "quota-capture",
    eventPayload: {},
    transcript: [],
    sessionState: [],
    earlierTranscript: [],
  });
  return { overview, detail, need };
};

it.each([1440, 390])(
  "makes quota recovery readable without hover and shows the same refusal on the board and run page at %i pixels",
  async (width) => {
    await page.viewport(width, 900);
    await commands.reducedMotion(true);
    const { overview, detail, need } = fixture();
    const overviewJson = JSON.stringify(Schema.encodeSync(FactoryOverview)(overview));
    const detailJson = JSON.stringify(Schema.encodeSync(RunDetailView)(detail));
    await commands.approvalResponses(overviewJson, overviewJson, detailJson, detailJson);
    const statistics = (window: "7d" | "30d" | "all") =>
      JSON.stringify(Schema.encodeSync(StatisticsView)(emptyStatisticsFixture(Date.now(), window)));
    const runStatistics = (window: "7d" | "30d" | "all") =>
      JSON.stringify(
        Schema.encodeSync(RunStatisticsView)(emptyRunStatisticsFixture(Date.now(), window)),
      );
    await commands.statisticsResponses(
      overviewJson,
      '{"running":[],"notMoving":[],"lastOutcomes":[],"workers":[],"polls":[]}',
      { "7d": statistics("7d"), "30d": statistics("30d"), all: statistics("all") },
      { "7d": runStatistics("7d"), "30d": runStatistics("30d"), all: runStatistics("all") },
    );
    await commands.githubChangesResponse('{"attempts":[]}');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({
      routeTree,
      context: { queryClient: client },
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const device = width === 390 ? "phone" : "desktop";
    try {
      await router.load();
      flushSync(() =>
        root.render(
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
        ),
      );
      for (const theme of ["dark", "light"]) {
        document.documentElement.classList.toggle("dark", theme === "dark");
        await router.navigate({ to: "/" });
        const needs = page.getByRole("region", { name: "Needs attention", exact: true });
        const actions = needs.getByRole("button", { name: /^Actions for hetzner-pool/ });
        await expect.element(actions).toBeVisible();
        await commands.configurationEditorScreenshot(`638-attention-${device}-${theme}`);
        await actions.click();
        await page.getByRole("menuitem", { name: "Details", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: needCopy(need).title, exact: true });
        const description = dialog.getByText(needCopy(need).detail, { exact: true });
        await expect.element(description).toBeVisible();
        const text = description.element();
        expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
        expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight);
        const range = document.createRange();
        range.selectNodeContents(text);
        const bounds = dialog.element().getBoundingClientRect();
        for (const line of range.getClientRects()) {
          expect(line.left).toBeGreaterThanOrEqual(bounds.left);
          expect(line.right).toBeLessThanOrEqual(bounds.right);
          expect(line.bottom).toBeLessThanOrEqual(bounds.bottom);
        }
        await commands.configurationEditorScreenshot(`638-recovery-${device}-${theme}`);
        await userEvent.keyboard("{Escape}");
        await expect.element(dialog).not.toBeInTheDocument();
        await expect.element(actions).toHaveFocus();
        await router.navigate({ to: "/projects/$project", params: { project: "board-test-repo" } });
        const wait = page.getByText(`Waiting for ${need.worker}: ${need.message}`, { exact: true });
        await expect.element(wait).toBeVisible();
        expect(wait.element().scrollWidth).toBeLessThanOrEqual(wait.element().clientWidth);
        await commands.configurationEditorScreenshot(`638-board-${device}-${theme}`);
        await router.navigate({
          to: "/projects/$project/runs/$run",
          params: { project: "board-test-repo", run: detail.run.id },
        });
        await expect.element(wait.first()).toBeVisible();
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
        await commands.configurationEditorScreenshot(`638-run-${device}-${theme}`);
        await page.getByRole("button", { name: "Needs attention (1)", exact: true }).click();
        const tray = page.getByRole("dialog", { name: "Needs attention 1", exact: true });
        await tray.getByRole("button", { name: /^Actions for hetzner-pool/ }).click();
        await page.getByRole("menuitem", { name: "Details", exact: true }).click();
        await expect.element(description).toBeVisible();
        await userEvent.keyboard("{Escape}");
        await expect.element(dialog).not.toBeInTheDocument();
        await userEvent.keyboard("{Escape}");
        await expect.element(tray).not.toBeInTheDocument();
      }
    } finally {
      flushSync(() => root.unmount());
      client.clear();
      host.remove();
      document.documentElement.classList.remove("dark");
      await commands.reducedMotion(false);
    }
  },
);
