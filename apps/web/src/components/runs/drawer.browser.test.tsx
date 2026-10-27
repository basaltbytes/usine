import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  AgentFailureView,
  ApprovalNeed,
  AttemptView,
  BoardItemLink,
  BoardView,
  FactoryOverview,
  FailedAttemptView,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunFailureNeed,
  RunView,
  LocalWorkerAccess,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    failureResolutionResponses: (
      before: string,
      after: string,
      detailBefore: string,
      detailAfter: string,
      attemptId: string,
    ) => Promise<void>;
  }
}

const repository = RepositoryName.make("resolution/project");
const runId = RunId.make("resolution-run");
const attemptId = AttemptId.make("resolution-attempt");
const agent = AgentName.make("developer");
const loop = LoopName.make("implement");
const failure = new AgentFailureView({ message: "Work was completed separately" });
const run = new RunView({
  id: runId,
  itemKey: ItemKey.make("github:resolution/project:1"),
  repository,
  loop,
  agent,
  state: "Failed",
  loopPaused: false,
  openedAt: "2026-09-17T00:00:00Z",
  closedAt: "2026-09-17T00:20:00Z",
  task: "Complete the issue",
  attempts: [
    new AttemptView({
      id: attemptId,
      number: AttemptNumber.make(1),
      worker: WorkerName.make("local"),
      workerAccess: new LocalWorkerAccess(),
      brain: new BrainSpec({ harness: "codex", model: ModelId.make("test"), effort: "high" }),
      task: AttemptTask.make("Complete the issue"),
      agent,
      operatorIntervened: false,
      startedAt: "2026-09-17T00:00:00Z",
      outcome: new FailedAttemptView({ failure }),
      endedAt: "2026-09-17T00:20:00Z",
      salvage: null,
    }),
  ],
  approval: null,
  runAgain: null,
  resultMessage: null,
  pullRequestUrl: null,
  canApprove: false,
  canCancel: false,
  canRunAgain: false,
  canRetry: true,
  canResolveFailure: true,
});
const unrelated = new ApprovalNeed({
  id: "other-approval",
  repository: RepositoryName.make("another/project"),
  runId: RunId.make("other-run"),
  loop,
  item: new BoardItemLink({
    itemKey: ItemKey.make("github:another/project:7"),
    kind: "issue",
    number: ItemNumber.make(7),
    title: "Write the release notes",
    url: "https://github.com/another/project/issues/7",
    state: "issue-open",
  }),
});

it("resolves a failure from Needs attention while retaining unrelated attention, failed history, and retry, and shows why a retry is refused", async () => {
  const before = new ReadyOverview({
    projects: [
      new ProjectView({
        repository,
        status: "needs-you",
        runs: [run],
        board: new BoardView({ lanes: [], failures: [] }),
        labels: [],
        preflightFindings: [],
      }),
    ],
    loops: [],
    needsYou: [new RunFailureNeed({ id: "failure", repository, runId, loop, failure }), unrelated],
  });
  const resolvedRun = new RunView({ ...run, canResolveFailure: false });
  const after = new ReadyOverview({
    ...before,
    needsYou: [unrelated],
    projects: before.projects.map(
      (project) => new ProjectView({ ...project, status: "clear", runs: [resolvedRun] }),
    ),
  });
  const detail = new RunDetailView({
    run,
    eventDedupKey: "event",
    eventPayload: {},
    transcript: [],
    sessionState: [],
    earlierTranscript: [],
  });
  await commands.failureResolutionResponses(
    JSON.stringify(Schema.encodeSync(FactoryOverview)(before)),
    JSON.stringify(Schema.encodeSync(FactoryOverview)(after)),
    JSON.stringify(Schema.encodeSync(RunDetailView)(detail)),
    JSON.stringify(
      Schema.encodeSync(RunDetailView)(new RunDetailView({ ...detail, run: resolvedRun })),
    ),
    attemptId,
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await page
      .getByRole("button", { name: /implement: agent failure.*Work was completed separately/ })
      .click();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Mark resolved", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "More actions", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .element(
        page.getByText('run newer-run of loop "implement" is open on the same item', {
          exact: false,
        }),
      )
      .toBeVisible();
    const drawer = page.getByRole("dialog");
    await expect.element(drawer.getByText("Agent failure", { exact: true })).toBeVisible();
    await expect
      .element(drawer.getByText("Work was completed separately", { exact: false }))
      .toBeVisible();
    // The labelled button in the body and the expand icon next to Close both link to the Run page.
    const toPage = drawer.getByRole("link", { name: "Open run page" });
    await expect.poll(() => toPage.elements().length).toBe(2);
    expect(new Set(toPage.elements().map((link) => link.getAttribute("href")))).toEqual(
      new Set(["/projects/resolution/project/runs/resolution-run"]),
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const needs = page.getByRole("region", { name: "Needs attention" });
    await expect
      .element(needs.getByRole("button", { name: /implement: agent failure/ }))
      .not.toBeInTheDocument();
    await expect
      .element(
        needs.getByRole("button", {
          name: /implement: approval needed.*Issue #7, open Write the release notes/,
        }),
      )
      .toBeVisible();
    await expect.element(needs.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect
      .element(needs.getByRole("button", { name: "Cancel run", exact: true }))
      .toBeVisible();
    expect(queryClient.getQueryData<ReadyOverview>(["overview"])?.projects[0]?.status).toBe(
      "clear",
    );
  } finally {
    flushSync(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});

it("leaves a closed issue's failed run out of Needs attention and marks the issue closed in its drawer", async () => {
  const onIssue = new RunView({
    ...run,
    itemKey: ItemKey.make('["github","resolution/project",1]'),
  });
  const overview = JSON.stringify(
    Schema.encodeSync(FactoryOverview)(
      new ReadyOverview({
        projects: [
          new ProjectView({
            repository,
            status: "needs-you",
            runs: [onIssue],
            board: new BoardView({ lanes: [], failures: [] }),
            labels: [],
            preflightFindings: [],
          }),
        ],
        loops: [],
        needsYou: [unrelated],
      }),
    ),
  );
  const detail = JSON.stringify(
    Schema.encodeSync(RunDetailView)(
      new RunDetailView({
        run: onIssue,
        eventDedupKey: "event",
        eventPayload: {},
        transcript: [],
        sessionState: [],
        earlierTranscript: [],
        settledItemState: "issue-closed",
      }),
    ),
  );
  await commands.failureResolutionResponses(overview, overview, detail, detail, attemptId);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/?run=${runId}`] }),
  });
  await router.load();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    const drawer = page.getByRole("dialog");
    await expect
      .element(drawer.getByRole("link", { name: "Issue #1, closed", exact: true }))
      .toBeVisible();
    await expect.element(drawer.getByText("Agent failure", { exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "More actions", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Mark resolved", exact: true }))
      .toBeVisible();
    // The open drawer hides the rest of the page from assistive technology.
    const needs = page.getByRole("region", { name: "Needs attention", includeHidden: true });
    await expect
      .element(
        needs.getByRole("button", {
          name: /implement: approval needed.*Issue #7, open Write the release notes/,
          includeHidden: true,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(needs.getByRole("button", { name: /implement: agent failure/, includeHidden: true }))
      .not.toBeInTheDocument();
  } finally {
    flushSync(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});
