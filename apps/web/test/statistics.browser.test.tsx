import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { DeskView, FactoryOverview, StatisticsView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { routeTree } from "../src/route-tree.gen.ts";
import { deskFixture, emptyStatisticsFixture, statisticsFixture } from "./desk-fixture.ts";
import "../src/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    statisticsResponses: (
      overview: string,
      desk: string,
      statistics: Readonly<Record<"7d" | "30d" | "all", string>>,
    ) => Promise<void>;
    statisticsRequests: () => Promise<ReadonlyArray<string | null>>;
  }
}

const now = Date.now();
const { desk, overview } = deskFixture(now);
const encode = (statistics: StatisticsView) =>
  JSON.stringify(Schema.encodeSync(StatisticsView)(statistics));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

/** Renders the Overview with the desk fixtures and `statistics` for each window. */
const renderOverview = async (statistics: Readonly<Record<"7d" | "30d" | "all", string>>) => {
  await commands.statisticsResponses(
    JSON.stringify(Schema.encodeSync(FactoryOverview)(overview)),
    JSON.stringify(Schema.encodeSync(DeskView)(desk)),
    statistics,
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
  const client = queryClient;
  const mounted = root;
  flushSync(() =>
    mounted.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
};

afterEach(() => {
  const mounted = root;
  if (mounted !== undefined) flushSync(() => mounted.unmount());
  queryClient?.clear();
  host?.remove();
});

const statistics = page.getByRole("region", { name: "Statistics", exact: true });
const figure = (value: string) =>
  statistics.getByRole("definition").filter({ hasText: new RegExp(`^${value}$`, "u") });

it("opens on 30 days, switches the window, and breaks runs down per loop, agent, and model", async () => {
  await renderOverview({
    "7d": encode(statisticsFixture(now, "7d")),
    "30d": encode(statisticsFixture(now, "30d")),
    all: encode(emptyStatisticsFixture(now, "all")),
  });

  await expect
    .element(statistics.getByRole("button", { name: "30 days" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(figure("36")).toBeInTheDocument();
  await expect.element(figure("18 min")).toBeInTheDocument();
  await expect.element(statistics.getByText(/^21 runs on .+, the busiest day$/u)).toBeVisible();
  await expect
    .element(statistics.getByText("75% succeeded, 17% failed, 8% canceled"))
    .toBeVisible();
  // The chart's values are in a table for screen readers: a heading row and one row per day.
  await expect
    .element(
      statistics
        .getByRole("table", { name: "Closed runs per period by outcome" })
        .getByRole("row")
        .nth(30),
    )
    .toBeInTheDocument();
  await expect
    .element(statistics.getByRole("meter", { name: "local slot use" }))
    .toHaveAttribute("aria-valuenow", "38");
  await expect
    .element(statistics.getByText("Longest median wait 2 min, on hz-worker-1"))
    .toBeVisible();

  await statistics.getByRole("button", { name: "7 days" }).click();
  await expect.element(figure("12")).toBeInTheDocument();
  await expect.element(statistics.getByText(/^7 runs on .+, the busiest day$/u)).toBeVisible();
  expect(await commands.statisticsRequests()).toEqual(["30d", "7d"]);

  await expect.element(statistics.getByRole("heading", { name: "Runs per loop" })).toBeVisible();
  await expect.element(statistics.getByRole("cell", { name: "review-fix" })).toBeVisible();
  await statistics.getByRole("button", { name: "Agent" }).click();
  await expect.element(statistics.getByRole("heading", { name: "Runs per agent" })).toBeVisible();
  await expect.element(statistics.getByRole("cell", { name: "reviewer" })).toBeVisible();
  await statistics.getByRole("button", { name: "Model" }).click();
  await expect
    .element(statistics.getByRole("heading", { name: "Attempts per model" }))
    .toBeVisible();
  await expect
    .element(statistics.getByRole("cell", { name: "claude · claude-opus-4-7 · high" }))
    .toBeVisible();
});

it("says what is missing when the window has no closed run", async () => {
  await renderOverview({
    "7d": encode(emptyStatisticsFixture(now, "7d")),
    "30d": encode(emptyStatisticsFixture(now, "30d")),
    all: encode(emptyStatisticsFixture(now, "all")),
  });

  await expect.element(figure("0")).toBeInTheDocument();
  await expect
    .element(statistics.getByRole("heading", { name: "Runs closed per day" }))
    .toBeVisible();
  await expect
    .element(statistics.getByText("No merged pull requests with a run in the last 30 days"))
    .toBeVisible();
  await expect
    .element(statistics.getByText("No approvals or failures in the last 30 days"))
    .toBeVisible();
  expect(statistics.getByRole("table").elements()).toHaveLength(0);

  await statistics.getByRole("button", { name: "All" }).click();
  await expect
    .element(statistics.getByText("No closed runs yet", { exact: true }).first())
    .toBeVisible();
});
