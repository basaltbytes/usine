import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import { WorkerName } from "@usine/core/worker";
import { AgentName } from "@usine/core/agent";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import {
  ApprovalNeed,
  UnresponsiveWorkerNeed,
  WorkerPreflightNeed,
  BoardItemLink,
  BoardView,
  FactoryOverview,
  type NeedView,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunView,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { overviewQuery } from "~/lib/overview";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    approvalResponses: (
      before: string,
      after: string,
      detailBefore: string,
      detailAfter: string,
    ) => Promise<void>;
    answerApproval: (status: 200 | 409, body: string) => Promise<void>;
    lateOverviewRequests: () => Promise<number>;
  }
}

const repository = RepositoryName.make("approval/project");
const runId = RunId.make("approval-run");
const loop = LoopName.make("start-dev");
const waiting = new RunView({
  agentBrain: new BrainSpec({
    harness: "codex",
    model: ModelId.make("test-model"),
    effort: "high",
  }),
  id: runId,
  itemKey: ItemKey.make("github:approval/project:367"),
  repository,
  loop,
  agent: AgentName.make("developer"),
  state: "Waiting",
  loopPaused: false,
  openedAt: "2026-10-21T14:40:00Z",
  closedAt: null,
  task: "Complete the issue",
  attempts: [],
  approval: null,
  runAgain: null,
  resultMessage: null,
  pullRequestUrl: null,
  canApprove: true,
  canCancel: true,
  canRunAgain: false,
  canRetry: false,
  canResolveFailure: false,
});
const running = new RunView({ ...waiting, state: "Running", canApprove: false });
const approvalOf = (id: RunId, number: number, title: string) =>
  new ApprovalNeed({
    id: `approval-${id}`,
    repository,
    runId: id,
    loop,
    item: new BoardItemLink({
      itemKey: ItemKey.make(`github:approval/project:${number}`),
      kind: "issue",
      number: ItemNumber.make(number),
      title,
      url: `https://github.com/approval/project/issues/${number}`,
      state: "issue-open",
    }),
  });
const approval = approvalOf(runId, 367, "Keep Needs attention current");
const unrelated = approvalOf(RunId.make("other-run"), 12, "Wait for the operator");
// The Project has no Runs, so the overview polls at its idle interval and the slow stub only
// receives the requests a test sends.
const overview = (needsYou: ReadonlyArray<NeedView>, runs: ReadonlyArray<RunView> = []) =>
  JSON.stringify(
    Schema.encodeSync(FactoryOverview)(
      new ReadyOverview({
        projects: [
          new ProjectView({
            repository,
            status: "needs-you",
            runs,
            board: new BoardView({ lanes: [], failures: [] }),
            labels: [],
            preflightFindings: [],
          }),
        ],
        loops: [],
        needsYou,
      }),
    ),
  );
const detail = (run: RunView) =>
  JSON.stringify(
    Schema.encodeSync(RunDetailView)(
      new RunDetailView({
        agentDefinitionChanged: false,
        run,
        eventDedupKey: "event",
        eventPayload: {},
        transcript: [],
        sessionState: [],
        earlierTranscript: [],
      }),
    ),
  );

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
beforeEach(async () => {
  await page.viewport(1280, 800);
  await commands.approvalResponses(
    overview([approval, unrelated]),
    overview([unrelated]),
    detail(waiting),
    detail(running),
  );
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
});
afterEach(() => {
  document.documentElement.classList.remove("dark");
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

// The open drawer hides the rest of the page, including Needs attention, from assistive technology.
const needs = page.getByRole("region", { name: "Needs attention", includeHidden: true });
const entry = (title: string) =>
  needs.getByRole("listitem", { includeHidden: true }).filter({ hasText: title });

it("holds the Run's approval in Needs attention while the drawer approves it, and drops it when the approve returns, before the slow overview refresh", async () => {
  const held = entry("#367 Keep Needs attention current");
  await held.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Open run", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
  await expect
    .element(held.getByRole("button", { name: "Approving…", includeHidden: true }))
    .toBeDisabled();
  await expect
    .element(
      entry("#12 Wait for the operator").getByRole("button", {
        name: "Approve",
        exact: true,
        includeHidden: true,
      }),
    )
    .toBeEnabled();
  await commands.answerApproval(200, '{"ok":true}');
  // Shorter than the 5 s overview refresh, which is still in flight.
  await expect.element(held, { timeout: 2_000 }).not.toBeInTheDocument();
  expect(queryClient.getQueryState(overviewQuery().queryKey)?.fetchStatus).toBe("fetching");
  await expect.element(entry("#12 Wait for the operator")).toBeInTheDocument();
  await expect
    .poll(() => queryClient.getQueryState(overviewQuery().queryKey)?.fetchStatus, {
      timeout: 10_000,
    })
    .toBe("idle");
  expect(await commands.lateOverviewRequests()).toBe(1);
  await expect.element(held).not.toBeInTheDocument();
  await expect.element(entry("#12 Wait for the operator")).toBeInTheDocument();
});

// Server response when the Run was already approved elsewhere.
const rejection = JSON.stringify({
  error: "RunOperationRejectedError",
  message: "Cannot approve Run approval-run while it is Running.",
});

it("shows no error on a Needs attention approval refused because the Run was approved elsewhere, and drops it with the refresh", async () => {
  const held = entry("#367 Keep Needs attention current");
  await held.getByRole("button", { name: "Approve", exact: true }).click();
  await commands.answerApproval(409, rejection);
  // The rejection triggers an overview refetch; the entry's buttons stay disabled until it returns.
  await expect.poll(() => commands.lateOverviewRequests()).toBe(1);
  await expect.element(held.getByRole("button", { name: "Approving…" })).toBeDisabled();
  await expect.element(held.getByText("Cannot approve", { exact: false })).not.toBeInTheDocument();
  await expect.element(held, { timeout: 10_000 }).not.toBeInTheDocument();
  await expect.element(page.getByText("Cannot approve", { exact: false })).not.toBeInTheDocument();
  await expect.element(entry("#12 Wait for the operator")).toBeInTheDocument();
});

it("explains in the drawer an approve refused because the Run was approved elsewhere", async () => {
  await entry("#367 Keep Needs attention current")
    .getByRole("button", { name: /^Actions for/ })
    .click();
  await page.getByRole("menuitem", { name: "Open run", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("button", { name: "Approve", exact: true }).click();
  await commands.answerApproval(409, rejection);
  await expect
    .element(drawer.getByText("Cannot approve Run approval-run while it is Running."), {
      timeout: 10_000,
    })
    .toBeVisible();
});

it("shows a silent worker's last answer and opens an affected run", async () => {
  const need = new UnresponsiveWorkerNeed({
    id: "worker:remote",
    worker: WorkerName.make("remote"),
    lastAnsweredAt: "2026-10-28T14:35:00.000Z",
    attempts: [runId, RunId.make("other-run")].map((id, index) => ({
      runId: id,
      attemptId: AttemptId.make(`attempt-${index}`),
      attemptNumber: AttemptNumber.make(index + 1),
      repository,
      loop,
    })),
  });
  await commands.approvalResponses(
    overview([need]),
    overview([need]),
    detail(running),
    detail(running),
  );
  await queryClient.invalidateQueries({ queryKey: overviewQuery().queryKey });
  const held = entry("remote");
  await expect.element(held.getByText(/Last answered 2026-10-28T14:35:00.000Z/)).toBeVisible();
  await held.getByRole("button", { name: /^Actions for/ }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "approval/project · start-dev · attempt 2" }))
    .toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Cancel run" })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.viewport(width, height);
    await expect.element(held).toBeVisible();
    await expect.poll(() => document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  }
  await held.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: "approval/project · start-dev · attempt 1" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
});

const bell = (count: number) =>
  page.getByRole("button", { name: `Needs attention (${count})`, exact: true });
const tray = () => page.getByRole("dialog", { name: /^Needs attention/ });
const replaceNeeds = async (
  needsYou: ReadonlyArray<NeedView>,
  runs: ReadonlyArray<RunView> = [],
) => {
  await commands.approvalResponses(
    overview(needsYou, runs),
    overview(needsYou, runs),
    detail(waiting),
    detail(running),
  );
  await queryClient.invalidateQueries({ queryKey: overviewQuery().queryKey });
};

it("opens with Enter and Space, tabs through row actions, and returns focus to the bell on Escape", async () => {
  await expect.element(bell(2)).toBeVisible();
  await expect.element(bell(2).getByText("2", { exact: true })).toBeVisible();
  bell(2).element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(tray()).toBeVisible();
  await expect.element(tray().getByRole("region", { name: "Approval needed (2)" })).toBeVisible();
  await expect.element(tray().getByRole("link", { name: /#367/ })).toHaveFocus();
  await userEvent.tab();
  await expect
    .element(tray().getByRole("button", { name: "Approve", exact: true }).first())
    .toHaveFocus();
  await userEvent.tab();
  const actions = tray().getByRole("button", { name: "Actions for Keep Needs attention current" });
  await expect.element(actions).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("menuitem", { name: "Cancel run", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(actions).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(tray()).not.toBeInTheDocument();
  await expect.element(bell(2)).toHaveFocus();
  await userEvent.keyboard(" ");
  await expect.element(tray()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(bell(2)).toHaveFocus();
});

it("approves in the dropdown and updates both counts before the slow refresh", async () => {
  await bell(2).click();
  const row = tray().getByRole("listitem").filter({ hasText: "#367" });
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(row.getByRole("button", { name: "Approving…" })).toBeDisabled();
  await commands.answerApproval(200, '{"ok":true}');
  await expect.element(row, { timeout: 2_000 }).not.toBeInTheDocument();
  await expect.element(bell(1)).toBeVisible();
  await expect
    .poll(
      () =>
        page.getByRole("link", { name: "Overview", exact: true }).first().element().closest("li")
          ?.textContent,
    )
    .toContain("1 need attention");
  await expect.element(tray().getByRole("region", { name: "Approval needed (1)" })).toBeVisible();
  await expect
    .poll(() => queryClient.getQueryState(overviewQuery().queryKey)?.fetchStatus, {
      timeout: 10_000,
    })
    .toBe("idle");
});

it("confirms cancellation from the row menu and disables cancellation during approval", async () => {
  await bell(2).click();
  const row = tray().getByRole("listitem").filter({ hasText: "#367" });
  const actions = row.getByRole("button", { name: /^Actions for/ });
  await actions.click();
  await page.getByRole("menuitem", { name: "Cancel run", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect.element(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Keep running" }).click();
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  await actions.click();
  await expect
    .element(page.getByRole("menuitem", { name: "Cancel run", exact: true }))
    .toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await commands.answerApproval(200, '{"ok":true}');
  await expect.element(row, { timeout: 2_000 }).not.toBeInTheDocument();
  await expect
    .poll(() => queryClient.getQueryState(overviewQuery().queryKey)?.fetchStatus, {
      timeout: 10_000,
    })
    .toBe("idle");
});

it("updates the open tray to an empty line and removes the bell badge", async () => {
  await bell(2).click();
  await replaceNeeds([]);
  await expect.element(bell(0)).toBeVisible();
  await expect.element(bell(0).getByText("0", { exact: true })).not.toBeInTheDocument();
  await expect.element(tray().getByText("Nothing needs attention", { exact: true })).toBeVisible();
  await tray().getByRole("link", { name: "View all on Overview" }).click();
  await expect.element(tray()).not.toBeInTheDocument();
  await expect.element(needs.getByText("Nothing needs attention", { exact: true })).toBeVisible();
});

const eightNeeds = [
  approval,
  unrelated,
  ...[
    "Show worker capacity",
    "Keep the run outcome visible after another attempt has started",
    "Retry a failed preflight",
    "Update loop settings",
    "Fix repository polling",
  ].map((title, index) => approvalOf(RunId.make(`approval-${index}`), 368 + index, title)),
  new WorkerPreflightNeed({
    id: "preflight-remote",
    worker: WorkerName.make("remote"),
    message: "SSH connection refused",
  }),
];

it.each(["dark", "light"])(
  "groups eight needs in a scrolling dropdown and a full-width phone sheet (%s)",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await replaceNeeds(
      eightNeeds,
      eightNeeds.flatMap((need) =>
        need._tag === "ApprovalNeed" ? [new RunView({ ...waiting, id: need.runId })] : [],
      ),
    );
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect.element(bell(8)).toBeVisible();
    await expect.poll(() => [...document.images].every((image) => image.complete)).toBe(true);
    await page.screenshot({
      path: `../../../../../.impeccable/review/notification-closed-${theme}.png`,
    });
    await bell(8).click();
    await expect.element(tray().getByRole("region", { name: "Approval needed (7)" })).toBeVisible();
    expect(tray().getByRole("listitem").all()).toHaveLength(8);
    await expect.element(tray().getByText(/ago/, { exact: false }).first()).toBeVisible();
    const popup = tray().element();
    await expect.poll(() => popup.getBoundingClientRect().width).toBe(400);
    expect(popup.getBoundingClientRect().height).toBeLessThanOrEqual(560);
    const scroll = tray().getByRole("region", { name: "Approval needed (7)" }).element()
      .parentElement?.parentElement;
    expect(scroll?.scrollHeight).toBeGreaterThan(scroll?.clientHeight ?? Infinity);
    const visibleRows = () => {
      const bounds = tray()
        .getByRole("region", { name: "Approval needed (7)" })
        .element()
        .parentElement?.parentElement?.getBoundingClientRect();
      return tray()
        .getByRole("listitem")
        .elements()
        .filter((row) => {
          const rect = row.getBoundingClientRect();
          return bounds !== undefined && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
        }).length;
    };
    expect(visibleRows()).toBeGreaterThanOrEqual(7);
    expect(
      tray()
        .getByRole("listitem")
        .elements()
        .every((row) => row.getBoundingClientRect().height <= 57),
    ).toBe(true);
    await page.screenshot({
      path: `../../../../../.impeccable/review/notification-open-${theme}.png`,
    });
    await userEvent.keyboard("{Escape}");
    await page.viewport(390, 844);
    await bell(8).click();
    await expect.element(tray()).toBeVisible();
    await expect.poll(() => tray().element().getBoundingClientRect().width).toBe(390);
    expect(tray().element().getBoundingClientRect().height).toBeLessThanOrEqual(591);
    expect(document.documentElement.scrollWidth).toBe(390);
    expect(visibleRows()).toBeGreaterThanOrEqual(7);
    expect(
      tray()
        .getByRole("listitem")
        .elements()
        .every((row) => row.getBoundingClientRect().height <= 57),
    ).toBe(true);
    await page.screenshot({
      path: `../../../../../.impeccable/review/notification-phone-${theme}.png`,
    });
    await userEvent.keyboard("{Escape}");
    await expect.element(tray()).not.toBeInTheDocument();
    await expect.element(bell(8)).toHaveFocus();
  },
);
