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

declare module "vitest/browser" {
  interface BrowserCommands {
    reloadResponses: (
      before: string,
      after: string,
      report: string,
      rejection: string,
    ) => Promise<void>;
  }
}

it("reloads the configuration from the Loops page and shows what changed or why it was refused", async () => {
  const agent = AgentName.make("developer");
  const loop = (name: string) =>
    new LoopView({ name: LoopName.make(name), trigger: "issue", agent, paused: false });
  const before = new ReadyOverview({ projects: [], loops: [loop("start-dev")], needsYou: [] });
  const after = new ReadyOverview({ ...before, loops: [loop("start-dev"), loop("triage")] });
  const noChanges = { added: [], removed: [], changed: [] };
  const report = new InstanceReload({
    loops: { added: [LoopName.make("triage")], removed: [], changed: [] },
    agents: noChanges,
    labels: noChanges,
    repos: noChanges,
    settingsChanged: false,
    operatorChanged: false,
    quarantinedLoops: [],
    invalidAgents: [],
  });
  await commands.reloadResponses(
    JSON.stringify(Schema.encodeSync(FactoryOverview)(before)),
    JSON.stringify(Schema.encodeSync(FactoryOverview)(after)),
    JSON.stringify(Schema.encodeSync(InstanceReload)(report)),
    JSON.stringify({
      error: "FactoryConfigError",
      message:
        "usine.yaml is invalid (yaml): Unexpected token. The running configuration is unchanged.",
    }),
  );
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
    await expect.element(page.getByRole("cell", { name: "triage", exact: true })).toBeVisible();

    await reload.click();
    await expect.element(page.getByText("Configuration not reloaded")).toBeVisible();
    await expect
      .element(page.getByText("The running configuration is unchanged", { exact: false }))
      .toBeVisible();
  } finally {
    flushSync(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});
