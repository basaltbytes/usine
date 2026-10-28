import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterContextProvider } from "@tanstack/react-router";
import {
  ApprovalNeed,
  FactoryOverview,
  ReadyOverview,
  projectAttention,
} from "@usine/orchestrator/operator";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { DeskNeedsYou } from "~/features/overview/overview.page";
import { overviewQuery } from "~/lib/overview";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    attentionResponses: (before: string, after: string) => Promise<void>;
  }
}

const Attention = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  return (
    <DeskNeedsYou
      needs={data.needsYou}
      dismissedNeeds={data.dismissedNeeds}
      polls={[]}
      now={Date.now()}
    />
  );
};

it("dismisses an approval, keeps it in a collapsed section after refresh, and restores it with Undo", async () => {
  const need = new ApprovalNeed({
    id: "approval:run",
    runId: RunId.make("run"),
    repository: RepositoryName.make("test/project"),
    loop: LoopName.make("implement"),
    item: null,
  });
  const before = new ReadyOverview({ projects: [], loops: [], needsYou: [need] });
  const after = new ReadyOverview({
    ...before,
    projects: projectAttention(before.projects, []),
    needsYou: [],
    dismissedNeeds: [need],
  });
  const encode = (overview: FactoryOverview) =>
    JSON.stringify(Schema.encodeSync(FactoryOverview)(overview));
  await commands.attentionResponses(encode(before), encode(after));
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await queries.ensureQueryData(overviewQuery());
  const router = createRouter({
    routeTree,
    context: { queryClient: queries },
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <RouterContextProvider router={router}>
            <Attention />
          </RouterContextProvider>
        </QueryClientProvider>,
      ),
    );
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect.element(page.getByText("Nothing needs attention")).toBeVisible();
    await expect.element(page.getByText("Dismissed (1)")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Undo", includeHidden: true }))
      .not.toBeVisible();
    await queries.invalidateQueries({ queryKey: overviewQuery().queryKey });
    expect(queries.getQueryData<FactoryOverview>(overviewQuery().queryKey)?.needsYou).toHaveLength(
      0,
    );
    await page.getByText("Dismissed (1)").click();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
    await queries.invalidateQueries({ queryKey: overviewQuery().queryKey });
    expect(queries.getQueryData<FactoryOverview>(overviewQuery().queryKey)?.needsYou).toHaveLength(
      1,
    );
    await expect.element(page.getByText("Dismissed (1)")).not.toBeInTheDocument();
  } finally {
    flushSync(() => root.unmount());
    queries.clear();
    host.remove();
  }
});
