import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterContextProvider } from "@tanstack/react-router";
import {
  ApprovalNeed,
  PoolLimitNeed,
  FactoryOverview,
  ReadyOverview,
  projectAttention,
} from "@usine/orchestrator/operator";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { DateTime, Option, Schema } from "effect";
import { PoolLogin } from "@usine/core/agent/session";
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

it.each([
  {
    kind: "approval",
    need: new ApprovalNeed({
      id: "approval:run",
      runId: RunId.make("run"),
      repository: RepositoryName.make("test/project"),
      loop: LoopName.make("implement"),
      item: null,
    }),
  },
  {
    kind: "pool warning",
    need: new PoolLimitNeed({
      id: "pool-limit:chatgptPlan:primary",
      pool: "chatgptPlan",
      login: Option.some(PoolLogin.make("operator@example.com")),
      window: "primary",
      usedPercent: 85,
      resetsAt: DateTime.makeUnsafe("2026-10-29T15:00:00Z"),
    }),
  },
])("dismisses a $kind across refreshes and restores it with Undo", async ({ need }) => {
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
    if (need._tag === "PoolLimitNeed") {
      await expect
        .element(page.getByText("ChatGPT plan: rate window at 85%", { exact: true }))
        .toBeVisible();
      await expect
        .element(
          page.getByText(
            "operator@example.com · primary window · resets 2026-10-29T15:00:00.000Z",
            { exact: true },
          ),
        )
        .toBeVisible();
    }
    await page.getByRole("button", { name: /^Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Dismiss", exact: true }).click();
    await expect.element(page.getByText("Nothing needs attention")).toBeVisible();
    const disclosure = page.getByRole("button", { name: "Dismissed (1)" });
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByRole("button", { name: "Undo", exact: true }))
      .not.toBeInTheDocument();
    await queries.invalidateQueries({ queryKey: overviewQuery().queryKey });
    expect(queries.getQueryData<FactoryOverview>(overviewQuery().queryKey)?.needsYou).toHaveLength(
      0,
    );
    await disclosure.click();
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.element(page.getByRole("button", { name: /^Actions for/ })).toBeVisible();
    if (need._tag === "ApprovalNeed")
      await expect
        .element(page.getByRole("button", { name: "Approve", exact: true }))
        .toBeEnabled();
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
