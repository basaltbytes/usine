import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { creationFailuresLine, nextCreationLine } from "../src/operator-copy.ts";
import { routeTree } from "../src/route-tree.gen.ts";
import { configurationFixture } from "./configuration-fixture.ts";
import "../src/index.css";

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const configuration = configurationFixture();
const hetzner = configuration.workers.find(({ name }) => name === "hz-pool");

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(
    ["overview"],
    new ReadyOverview({ projects: [], loops: [], needsYou: [] }),
  );
  queryClient.setQueryData(["configuration"], configuration);
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

const mount = async (path: string, width = 1280) => {
  await page.viewport(width, 900);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  await router.load();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
};

const row = (name: string | RegExp) => page.getByRole("row", { name });

/** Returns the visible text of each machine row, cells joined by ` | `. */
const machineRows = () =>
  page
    .getByRole("table")
    .first()
    .getByRole("row")
    .elements()
    .slice(1)
    .map((element) =>
      [...element.querySelectorAll<HTMLElement>("td")]
        .filter((cell) => cell.checkVisibility())
        .map((cell) => cell.innerText.replaceAll(/\s+/gu, " ").trim())
        .join(" | "),
    );

it("lists a Hetzner worker's machines oldest first under its last failed creation", async () => {
  const pause = hetzner?.provisioning;
  if (pause === null || pause === undefined) throw new Error("Expected a failed creation");
  await mount("/configuration/workers/hz-pool");
  await expect.element(page.getByText("Machine creation failed: quota reached")).toBeVisible();
  await expect
    .element(
      page.getByText(
        "Hetzner Cloud refused the server: server limit reached (resource_limit_exceeded)",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect
    .element(
      page.getByText(
        `${creationFailuresLine(pause, Date.now())}. ${nextCreationLine(pause, Date.now())}`,
        { exact: true },
      ),
    )
    .toBeVisible();

  expect(machineRows()).toEqual([
    "52341001 | Deleting | 1h | Attempt 7c1d2e3f, found after a restart",
    "52341896 | Ready | 12m | Run 1a2b3c4d",
    "No ID yet | Creating | 1m | Run 9f8e7d6c",
  ]);
  await expect
    .element(row(/52341896/u).getByRole("link", { name: "Run 1a2b3c4d" }))
    .toHaveAttribute(
      "href",
      "/configuration/workers/hz-pool?run=1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    );
});

it("folds what each machine is for under its ID on a phone, without scrolling sideways", async () => {
  await mount("/configuration/workers/hz-pool", 390);
  await expect.element(row(/52341896/u)).toBeVisible();
  expect(machineRows()).toEqual([
    "52341001 Attempt 7c1d2e3f, found after a restart | Deleting | 1h",
    "52341896 Run 1a2b3c4d | Ready | 12m",
    "No ID yet Run 9f8e7d6c | Creating | 1m",
  ]);
  const container = page.getByRole("table").first().element().parentElement;
  expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
});

it("shows harness checks as deferred to the first machine of each day", async () => {
  await mount("/configuration/workers/hz-pool");
  await expect
    .element(
      page.getByText("Harness checks run on the first machine of each day.", { exact: true }),
    )
    .toBeVisible();
  const claude = row(/Claude Code/u);
  await expect.element(claude.getByText("Deferred", { exact: true })).toBeVisible();
  await expect
    .element(
      claude.getByText(
        "Checked on the worker's first machine each day, since no machine exists before an attempt.",
      ),
    )
    .toBeVisible();
});

it("says on the Workers list that a worker's machine creation is paused", async () => {
  const pause = hetzner?.provisioning;
  if (pause === null || pause === undefined) throw new Error("Expected a failed creation");
  await mount("/configuration/workers");
  const worker = row(/^hz-pool/u);
  await expect
    .element(worker.getByText("hetzner cx33 in nbg1, one machine per attempt", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      worker.getByText(
        `Machine creation failed: quota reached. ${nextCreationLine(pause, Date.now())}`,
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect.element(row(/^boat-pool/u).getByText("Deferred", { exact: true })).toBeVisible();
});
