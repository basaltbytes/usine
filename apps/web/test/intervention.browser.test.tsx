import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentName } from "@usine/core/agent";
import { AgentSessionId } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { ChildTarget, ParentTarget } from "@usine/core/attempt/channel";
import {
  CycleBudgetAsk,
  CycleBudgetAskId,
  CycleCount,
  CycleLimit,
  LoopCycleCount,
} from "@usine/core/cycle-budget";
import { EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { Claimed, CycleBlocked, RunAgainResult } from "@usine/engine/engine";
import { RunView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { SessionComposer } from "../src/run-intervention/session-composer.tsx";
import { ContextualActions } from "../src/run-intervention/contextual-actions.tsx";
import { EditAndRetry } from "../src/run-intervention/edit-and-retry.tsx";
import { runAgainBlocked } from "../src/operator-copy.ts";
import "../src/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    interventionResponses: (status: 200 | 503) => Promise<void>;
    runAgainResponse: (body: string) => Promise<void>;
    recordedInterventions: () => Promise<
      Array<{ url: string; body: unknown; headers: ReadonlyArray<string> }>
    >;
  }
}
const runId = RunId.make("intervention-test");
const attemptId = AttemptId.make("attempt-2");
const failedRun = new RunView({
  id: runId,
  itemKey: ItemKey.make("issue-34"),
  loop: LoopName.make("implement"),
  repository: RepositoryName.make("basaltbytes/usine"),
  agent: AgentName.make("developer"),
  state: "Failed",
  loopPaused: false,
  openedAt: "2026-09-12T00:00:00Z",
  closedAt: "2026-09-12T00:30:00Z",
  task: "Original task",
  attempts: [],
  approval: null,
  runAgain: null,
  resultMessage: null,
  pullRequestUrl: null,
  canApprove: false,
  canRetry: true,
  canResolveFailure: true,
  canCancel: false,
  canRunAgain: false,
});
const succeededRun = new RunView({
  ...failedRun,
  state: "Succeeded",
  canRetry: false,
  canResolveFailure: false,
  canRunAgain: true,
});
const runAgainBody = (result: RunAgainResult) =>
  JSON.stringify(Schema.encodeSync(RunAgainResult)(result));
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const mount = (children: ReactNode) =>
  flushSync(() =>
    root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>),
  );
beforeEach(async () => {
  await commands.interventionResponses(200);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement("div");
  host.style.cssText = "width:700px;padding:24px";
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  host.remove();
});

it("addresses parent and child messages independently and exposes an explicit release for each", async () => {
  mount(
    <>
      <section aria-label="Parent">
        <SessionComposer
          runId={runId}
          attemptId={attemptId}
          target={new ParentTarget()}
          paused
          held
        />
      </section>
      <section aria-label="Child">
        <SessionComposer
          runId={runId}
          attemptId={attemptId}
          target={new ChildTarget({ sessionId: AgentSessionId.make("child-2") })}
          paused={false}
          held={false}
        />
      </section>
    </>,
  );
  await page.getByLabelText("Message this child").fill("Check the second approach with me");
  await page
    .getByRole("region", { name: "Child", exact: true })
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await expect.element(page.getByLabelText("Message this child")).toHaveValue("");
  await page.getByLabelText("Message the parent").fill("Continue after the review");
  await page.getByRole("button", { name: "Send and resume" }).click();
  await expect.element(page.getByLabelText("Message the parent")).toHaveValue("");
  await page
    .getByRole("region", { name: "Child", exact: true })
    .getByRole("button", { name: "Pause session" })
    .click();
  await expect.element(page.getByRole("button", { name: "Release child" })).toBeEnabled();
  await page.getByRole("button", { name: "Release child" }).click();
  await page.getByRole("button", { name: "Release parent" }).click();
  await expect.poll(async () => (await commands.recordedInterventions()).length).toBe(5);
  expect((await commands.recordedInterventions()).map(({ body }) => body)).toEqual([
    {
      attemptId,
      target: { _tag: "Child", sessionId: "child-2" },
      action: { _tag: "OperatorMessage", message: "Check the second approach with me" },
    },
    {
      attemptId,
      target: { _tag: "Parent" },
      action: { _tag: "OperatorMessage", message: "Continue after the review" },
    },
    { attemptId, target: { _tag: "Child", sessionId: "child-2" }, action: { _tag: "Interrupt" } },
    { attemptId, target: { _tag: "Child", sessionId: "child-2" }, action: { _tag: "Release" } },
    { attemptId, target: { _tag: "Parent" }, action: { _tag: "Release" } },
  ]);
});

it("edits failed task text and selects the replacement roster agent", async () => {
  let closed = false;
  mount(
    <EditAndRetry
      run={failedRun}
      intent="retry"
      close={() => {
        closed = true;
      }}
      openRun={() => {}}
    />,
  );
  await expect.element(page.getByLabelText("Task", { exact: true })).toHaveValue("Original task");
  await page.getByLabelText("Task", { exact: true }).fill("Resolve the review findings");
  await expect
    .element(page.getByRole("option", { name: "reviewer", exact: true }))
    .toBeInTheDocument();
  await userEvent.selectOptions(page.getByLabelText("Agent", { exact: true }), "reviewer");
  await page.getByRole("button", { name: "Save and retry" }).click();
  await expect.poll(() => closed).toBe(true);
  const requests = await commands.recordedInterventions();
  expect(requests[0]?.url).toContain("/edit-and-retry");
  expect(requests[0]?.body).toEqual({ task: "Resolve the review findings", agent: "reviewer" });
  expect(requests[0]?.headers).not.toContain("traceparent");
  expect(requests[0]?.headers).not.toContain("b3");
});

it("runs a succeeded Run again as it ended or with an edited task and agent, and opens each new Run", async () => {
  const opened: Array<RunId> = [];
  await commands.runAgainResponse(
    runAgainBody(
      new Claimed({ eventId: EventId.make("run-again-event"), runId: RunId.make("opened-again") }),
    ),
  );
  mount(
    <ContextualActions
      run={succeededRun}
      onEdit={() => {}}
      openRun={(id) => void opened.push(id)}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Retry", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Edit and run again", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Run again", exact: true }).click();
  await expect.poll(() => opened).toEqual(["opened-again"]);

  mount(
    <EditAndRetry
      run={succeededRun}
      intent="runAgain"
      close={() => {}}
      openRun={(id) => void opened.push(id)}
    />,
  );
  await page.getByLabelText("Task", { exact: true }).fill("Finish the review this time");
  await expect
    .element(page.getByRole("option", { name: "reviewer", exact: true }))
    .toBeInTheDocument();
  await userEvent.selectOptions(page.getByLabelText("Agent", { exact: true }), "reviewer");
  await page.getByRole("button", { name: "Save and run again", exact: true }).click();
  await expect.poll(() => opened).toEqual(["opened-again", "opened-again"]);
  const requests = await commands.recordedInterventions();
  expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
    "/api/runs/intervention-test/run-again",
    "/api/runs/intervention-test/run-again",
  ]);
  expect(requests.map(({ body }) => body)).toEqual([
    { task: "Original task", agent: "developer" },
    { task: "Finish the review this time", agent: "reviewer" },
  ]);
});

it("says that running a Run again opened no Run once the Item's cycle budget is used up", async () => {
  const opened: Array<RunId> = [];
  const loop = LoopName.make("implement");
  await commands.runAgainResponse(
    runAgainBody(
      new CycleBlocked({
        eventId: EventId.make("run-again-event"),
        ask: new CycleBudgetAsk({
          id: CycleBudgetAskId.make("exhausted"),
          itemKey: succeededRun.itemKey,
          repository: succeededRun.repository,
          loop,
          limit: CycleLimit.make(1),
          counts: [
            new LoopCycleCount({
              loop,
              admitted: CycleCount.make(1),
              completed: CycleCount.make(1),
            }),
          ],
        }),
      }),
    ),
  );
  mount(
    <ContextualActions
      run={succeededRun}
      onEdit={() => {}}
      openRun={(id) => void opened.push(id)}
    />,
  );
  await page.getByRole("button", { name: "Run again", exact: true }).click();
  await expect.element(page.getByText(runAgainBlocked, { exact: true })).toBeVisible();
  expect(opened).toEqual([]);
});

it("retains unsent guidance and displays a delivery failure", async () => {
  await commands.interventionResponses(503);
  mount(
    <SessionComposer
      runId={runId}
      attemptId={attemptId}
      target={new ParentTarget()}
      paused={false}
      held={false}
    />,
  );
  // Release parent is not offered when the parent is neither paused nor held.
  await expect
    .element(page.getByRole("button", { name: "Release parent" }))
    .not.toBeInTheDocument();
  await page.getByLabelText("Message the parent").fill("Keep this guidance");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.element(page.getByText("Worker is disconnected", { exact: true })).toBeVisible();
  await expect.element(page.getByLabelText("Message the parent")).toHaveValue("Keep this guidance");
});
