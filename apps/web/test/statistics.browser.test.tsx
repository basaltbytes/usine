import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import {
  DeskView,
  FactoryOverview,
  RunStatisticsView,
  StatisticsView,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { routeTree } from "../src/route-tree.gen.ts";
import {
  deskFixture,
  emptyRunStatisticsFixture,
  emptyStatisticsFixture,
  runStatisticsFixture,
  statisticsFixture,
  weeklyStatisticsFixture,
} from "./desk-fixture.ts";
import "../src/index.css";

type Windows = Readonly<Record<"7d" | "30d" | "all", string>>;

declare module "vitest/browser" {
  interface BrowserCommands {
    statisticsResponses: (
      overview: string,
      desk: string,
      statistics: Windows,
      runStatistics: Windows,
    ) => Promise<void>;
    statisticsRequests: () => Promise<{
      readonly tasks: ReadonlyArray<string | null>;
      readonly runs: ReadonlyArray<string | null>;
    }>;
  }
}

const now = Date.now();
const { desk, overview } = deskFixture(now);
const encode = (statistics: StatisticsView) =>
  JSON.stringify(Schema.encodeSync(StatisticsView)(statistics));
const encodeRuns = (statistics: RunStatisticsView) =>
  JSON.stringify(Schema.encodeSync(RunStatisticsView)(statistics));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

/** Renders the Overview with the desk fixtures and the task and run statistics of each window. */
const renderOverview = async (statistics: Windows, runStatistics: Windows) => {
  await commands.statisticsResponses(
    JSON.stringify(Schema.encodeSync(FactoryOverview)(overview)),
    JSON.stringify(Schema.encodeSync(DeskView)(desk)),
    statistics,
    runStatistics,
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
const runFixtures = {
  "7d": encodeRuns(runStatisticsFixture(now, "7d")),
  "30d": encodeRuns(runStatisticsFixture(now, "30d")),
  all: encodeRuns(emptyRunStatisticsFixture(now, "all")),
};

it("leads the Overview with the tasks done and reads the run statistics only behind Details", async () => {
  await renderOverview(
    {
      "7d": encode(statisticsFixture(now, "7d")),
      "30d": encode(statisticsFixture(now, "30d")),
      all: encode(weeklyStatisticsFixture(now)),
    },
    runFixtures,
  );

  await expect
    .element(statistics.getByRole("button", { name: "30 days" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(statistics.getByText("12 tasks", { exact: true })).toBeVisible();
  await expect
    .element(statistics.getByText("2 h 6 min median time in usine", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Recent runs" })).toBeVisible();
  expect(
    page
      .getByRole("heading", { level: 2 })
      .elements()
      .map(({ textContent }) => textContent),
  ).toEqual(["Statistics", "Needs attention", "Running", "Stalled", "Recent runs"]);
  // One row per task done in the screen-reader table, after its heading row.
  await expect
    .element(
      statistics.getByRole("table", { name: "Tasks done, time in usine" }).getByRole("row").nth(12),
    )
    .toBeInTheDocument();
  await expect
    .element(
      statistics.getByRole("img", {
        name: "Time per task: start-dev 32%, review-fix 8%, waiting 60%",
      }),
    )
    .toBeVisible();
  await expect.element(statistics.getByText("start-dev about 40 min")).toBeVisible();
  await expect.element(statistics.getByText("review-fix about 4 min")).toBeVisible();
  await expect.element(statistics.getByText("75% of tasks", { exact: true })).toBeVisible();
  await expect
    .element(statistics.getByText("1.5 operator actions per task", { exact: true }))
    .toBeVisible();
  await expect.element(statistics.getByText("620K median", { exact: true })).toBeVisible();
  await expect.element(statistics.getByText("~$3.10 median price", { exact: true })).toBeVisible();
  await expect
    .element(
      statistics.getByText(
        /^3 tasks before \d+ \w+ lack timing and are left out; 2 tasks lack a price and are left out of the median price$/u,
      ),
    )
    .toBeVisible();
  expect(statistics.getByText(/p90|9 in 10/u).elements()).toHaveLength(0);
  expect((await commands.statisticsRequests()).runs).toEqual([]);

  await statistics.getByRole("button", { name: "Details" }).click();
  await expect.element(statistics.getByRole("heading", { name: "Runs per loop" })).toBeVisible();
  await expect
    .element(statistics.getByRole("definition").filter({ hasText: /^36$/u }))
    .toBeVisible();
  await expect.element(statistics.getByRole("cell", { name: "review-fix" })).toBeVisible();
  await statistics.getByRole("button", { name: "Agent" }).click();
  await expect.element(statistics.getByRole("cell", { name: "reviewer" })).toBeVisible();
  await expect
    .element(statistics.getByRole("meter", { name: "local slot use" }))
    .toHaveAttribute("aria-valuenow", "38");

  await statistics.getByRole("button", { name: "7 days" }).click();
  await expect.element(statistics.getByText("4 tasks", { exact: true })).toBeVisible();
  expect(statistics.getByText("median price", { exact: true }).elements()).toHaveLength(0);
  await expect
    .element(statistics.getByRole("definition").filter({ hasText: /^12$/u }))
    .toBeVisible();
  expect(await commands.statisticsRequests()).toEqual({
    tasks: ["30d", "7d"],
    runs: ["30d", "7d"],
  });

  // Twenty weeks count per week: columns of tasks over the median per week.
  await statistics.getByRole("button", { name: "All" }).click();
  await expect.element(statistics.getByText("40 tasks", { exact: true })).toBeVisible();
  await expect
    .element(statistics.getByRole("listitem").filter({ hasText: /^tasks$/u }))
    .toBeVisible();
  await expect.element(statistics.getByText("No task with recorded attempt times")).toBeVisible();
});

it("says what is missing when the window has no task done", async () => {
  await renderOverview(
    {
      "7d": encode(emptyStatisticsFixture(now, "7d")),
      "30d": encode(emptyStatisticsFixture(now, "30d")),
      all: encode(emptyStatisticsFixture(now, "all")),
    },
    {
      "7d": encodeRuns(emptyRunStatisticsFixture(now, "7d")),
      "30d": encodeRuns(emptyRunStatisticsFixture(now, "30d")),
      all: encodeRuns(emptyRunStatisticsFixture(now, "all")),
    },
  );

  await expect.element(statistics.getByText("No tasks done in the last 30 days")).toBeVisible();
  expect(statistics.getByRole("table").elements()).toHaveLength(0);
  await statistics.getByRole("button", { name: "All" }).click();
  await expect.element(statistics.getByText("No tasks done yet")).toBeVisible();
  await statistics.getByRole("button", { name: "Details" }).click();
  await expect
    .element(statistics.getByText("No closed runs yet", { exact: true }).first())
    .toBeVisible();
});
