import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { AgentName } from "@usine/core/agent";
import { LoopName } from "@usine/core/loop";
import { InstanceReload } from "@usine/orchestrator/current-instance";
import { FactoryOverview, LoopView, ReadyOverview } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { routeTree } from "../src/route-tree.gen.ts";
import "../src/index.css";
import { configurationJson } from "./configuration-fixture.ts";

declare module "vitest/browser" {
  interface BrowserCommands {
    reloadResponses: (
      before: string,
      after: string,
      report: string,
      rejections: ReadonlyArray<{ readonly status: number; readonly body: string }>,
      configurationBefore: string,
      configurationAfter: string,
    ) => Promise<void>;
  }
}

it("reloads the configuration from any Configuration page and shows what changed or why it was refused", async () => {
  const agent = AgentName.make("developer");
  const loop = (name: string) =>
    new LoopView({ name: LoopName.make(name), trigger: "issue", agent, paused: false });
  const before = new ReadyOverview({ projects: [], loops: [loop("start-dev")], needsYou: [] });
  const after = new ReadyOverview({ ...before, loops: [loop("start-dev"), loop("triage")] });
  const configurationAfter = {
    ...configurationJson,
    loops: [
      ...configurationJson.loops,
      ...configurationJson.loops
        .slice(0, 1)
        .map((loop) => ({ ...loop, name: "triage", file: "loops/triage.md" })),
    ],
  };
  const noChanges = { added: [], removed: [], changed: [] };
  const report = new InstanceReload({
    loops: { added: [LoopName.make("triage")], removed: [], changed: [] },
    agents: noChanges,
    labels: noChanges,
    repos: noChanges,
    workers: noChanges,
    settingsChanged: false,
    operatorChanged: false,
    quarantinedLoops: [],
    invalidAgents: [],
  });
  await commands.reloadResponses(
    JSON.stringify(Schema.encodeSync(FactoryOverview)(before)),
    JSON.stringify(Schema.encodeSync(FactoryOverview)(after)),
    JSON.stringify(Schema.encodeSync(InstanceReload)(report)),
    [
      {
        status: 422,
        body: JSON.stringify({
          error: "FactoryConfigError",
          message:
            "usine.yaml is invalid (yaml): Unexpected token. The running configuration is unchanged.",
          file: "usine.yaml",
          stage: "yaml",
        }),
      },
      {
        status: 409,
        body: JSON.stringify({
          error: "ReloadPreflightError",
          message:
            "Worker preflight failed for Agent reviewer and Worker eu-1, which the reload adds or gives more slots. Worker local: Claude Code is not logged in. The running configuration is unchanged; fix the Worker, usine.yaml, or the Agent file, then reload again.",
          agents: ["reviewer"],
          workers: ["eu-1"],
          cause: {
            _tag: "WorkerCapabilityError",
            worker: "local",
            capability: "harness-login",
            message: "Claude Code is not logged in.",
          },
        }),
      },
      {
        status: 409,
        body: JSON.stringify({
          error: "RestartRequiredError",
          message:
            "usine.yaml changed in a way that applies only when usine up restarts: Worker eu-1 changed its destination; the webhooks block changed. The running configuration is unchanged; restart usine up to apply the change.",
          blocks: ["workers", "webhooks"],
          fields: ["workers.eu-1.destination", "webhooks"],
        }),
      },
    ],
    JSON.stringify(configurationJson),
    JSON.stringify(configurationAfter),
  );
  await page.viewport(1280, 800);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/configuration/loops"] }),
  });
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
    const reload = page.getByRole("button", { name: "Reload configuration" });
    await reload.click();
    await expect.element(page.getByText("Configuration reloaded")).toBeVisible();
    await expect.element(page.getByText("Loops added: triage")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "triage", exact: true })).toBeVisible();

    // The result stays on screen while the operator moves to another page of the section.
    await page.getByRole("link", { name: "Workers", exact: true }).click();
    await expect.element(page.getByRole("heading", { name: "Workers" })).toBeVisible();
    await expect.element(page.getByText("Loops added: triage")).toBeVisible();

    await page.getByRole("button", { name: "Reload configuration" }).click();
    await expect.element(page.getByText("Configuration not reloaded")).toBeVisible();
    await expect
      .element(page.getByText("usine.yaml, or the loops or agents folder, could not be loaded."))
      .toBeVisible();
    await expect
      .element(page.getByText("The running configuration is unchanged", { exact: false }))
      .toBeVisible();

    await page.getByRole("button", { name: "Dismiss the reload result" }).click();
    await expect.element(page.getByText("Configuration not reloaded")).not.toBeInTheDocument();

    // A refused preflight links the Worker whose check failed and what the reload adds.
    const refusal = page.getByRole("alert").filter({ hasText: "Configuration not reloaded" });
    await page.getByRole("button", { name: "Reload configuration" }).click();
    await expect
      .element(refusal.getByText("Failed check: harness login on Worker", { exact: false }))
      .toBeVisible();
    await expect.element(refusal.getByRole("link", { name: "reviewer" })).toBeVisible();
    await expect.element(refusal.getByRole("link", { name: "eu-1" })).toBeVisible();
    await refusal.getByRole("link", { name: "local" }).click();
    await expect.element(page.getByRole("heading", { name: "local" })).toBeVisible();

    // A change only a restart applies links each changed field of usine.yaml.
    await page.getByRole("button", { name: "Reload configuration" }).click();
    await expect
      .element(refusal.getByText("Changed in usine.yaml:", { exact: false }))
      .toBeVisible();
    await expect.element(refusal.getByRole("link", { name: "webhooks" })).toBeVisible();
    await refusal.getByRole("link", { name: "workers.eu-1.destination" }).click();
    await expect.element(page.getByRole("heading", { name: "eu-1" })).toBeVisible();
  } finally {
    flushSync(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});
