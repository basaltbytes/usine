import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { AgentName } from "@usine/core/agent";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import {
  ApprovalNeed,
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
import { commands, page } from "vitest/browser";
import { routeTree } from "../src/route-tree.gen.ts";
import "../src/index.css";

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
    }),
  });
const approval = approvalOf(runId, 367, "Approve from the drawer");
const unrelated = approvalOf(RunId.make("other-run"), 12, "Wait for the operator");
// The Project lists no Runs, so the overview refreshes on its idle interval and only the
// requests a test sends reach the slow stub.
const overview = (needsYou: ReadonlyArray<NeedView>) =>
  JSON.stringify(
    Schema.encodeSync(FactoryOverview)(
      new ReadyOverview({
        projects: [
          new ProjectView({
            repository,
            status: "needs-you",
            runs: [],
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
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
});
afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

// The open drawer hides the rest of the page from assistive technology, Needs attention included.
const needs = page.getByRole("region", { name: "Needs attention", includeHidden: true });
const entry = (title: string) =>
  needs.getByRole("listitem", { includeHidden: true }).filter({ hasText: title });

it("holds the Run's approval in Needs attention while the drawer approves it, and drops it when the approve returns, before the slow overview refresh", async () => {
  const held = entry("#367 Approve from the drawer");
  await needs
    .getByRole("button", { name: /start-dev: approval needed.*#367/, includeHidden: true })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
  await expect
    .element(held.getByRole("button", { name: "Approving…", includeHidden: true }))
    .toBeDisabled();
  await expect
    .element(held.getByRole("button", { name: "Cancel run", includeHidden: true }))
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
  // Well within the 5 s the overview refresh takes, which is still on its way.
  await expect.element(held, { timeout: 2_000 }).not.toBeInTheDocument();
  expect(queryClient.getQueryState(["overview"])?.fetchStatus).toBe("fetching");
  await expect.element(entry("#12 Wait for the operator")).toBeInTheDocument();
  await expect
    .poll(() => queryClient.getQueryState(["overview"])?.fetchStatus, { timeout: 10_000 })
    .toBe("idle");
  expect(await commands.lateOverviewRequests()).toBe(1);
  await expect.element(held).not.toBeInTheDocument();
  await expect.element(entry("#12 Wait for the operator")).toBeInTheDocument();
});
