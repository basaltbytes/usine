import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentName } from "@usine/core/agent";
import { AgentSessionId } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { ChildTarget, ParentTarget } from "@usine/core/attempt/channel";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { RunView } from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { SessionComposer } from "../src/run-intervention/session-composer.tsx";
import { EditAndRetry } from "../src/run-intervention/edit-and-retry.tsx";
import "../src/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    interventionResponses: (status: 200 | 503) => Promise<void>;
    recordedInterventions: () => Promise<Array<{ url: string; body: unknown }>>;
  }
}
const runId = RunId.make("intervention-test");
const attemptId = AttemptId.make("attempt-2");
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

it("addresses parent and child messages independently and exposes an explicit child release", async () => {
  mount(
    <>
      <section aria-label="Parent">
        <SessionComposer runId={runId} attemptId={attemptId} target={new ParentTarget()} paused />
      </section>
      <section aria-label="Child">
        <SessionComposer
          runId={runId}
          attemptId={attemptId}
          target={new ChildTarget({ sessionId: AgentSessionId.make("child-2") })}
          paused={false}
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
  await expect.poll(async () => (await commands.recordedInterventions()).length).toBe(4);
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
  ]);
});

it("edits failed task text and selects the replacement roster agent", async () => {
  let closed = false;
  const run = new RunView({
    id: runId,
    itemKey: ItemKey.make("issue-34"),
    loop: LoopName.make("implement"),
    repository: RepositoryName.make("basaltbytes/usine"),
    agent: AgentName.make("developer"),
    state: "Failed",
    loopPaused: false,
    openedAt: "2026-09-12T00:00:00Z",
    task: "Original task",
    attempts: [],
    approval: null,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: false,
    canRetry: true,
    canResolveFailure: true,
    canCancel: false,
  });
  mount(
    <EditAndRetry
      run={run}
      close={() => {
        closed = true;
      }}
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
});

it("retains unsent guidance and displays a delivery failure", async () => {
  await commands.interventionResponses(503);
  mount(
    <SessionComposer
      runId={runId}
      attemptId={attemptId}
      target={new ParentTarget()}
      paused={false}
    />,
  );
  await page.getByLabelText("Message the parent").fill("Keep this guidance");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.element(page.getByText("Worker is disconnected", { exact: true })).toBeVisible();
  await expect.element(page.getByLabelText("Message the parent")).toHaveValue("Keep this guidance");
});
