import { Schema } from "effect";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import {
  ConfigurationView,
  WorkerConfigurationView,
  ReadyOverview,
} from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { overviewQuery } from "~/lib/overview";
import { configurationQuery } from "~/lib/configuration/queries";
import { creationFailuresLine, nextCreationLine } from "~/lib/workers/strings";
import { routeTree } from "~/route-tree.gen";
import { configurationFixture } from "~/lib/configuration/fixture";
import "~/index.css";

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
    overviewQuery().queryKey,
    new ReadyOverview({ projects: [], loops: [], needsYou: [] }),
  );
  queryClient.setQueryData(configurationQuery().queryKey, configuration);
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

it("shows deferred harness checks with the configured interval", async () => {
  await mount("/configuration/workers/hz-pool");
  await expect
    .element(page.getByText(/configured interval since the last successful check/u))
    .toBeVisible();
  const claude = row(/Claude Code/u);
  await expect.element(claude.getByText("Deferred", { exact: true })).toBeVisible();
  await expect
    .element(
      claude.getByRole("cell", {
        name: "Checked on the first machine, then every 86400 seconds when a machine is created.",
        exact: false,
      }),
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

declare module "vitest/browser" {
  interface BrowserCommands {
    workerPreflightResponses: (configuration: string) => Promise<void>;
    finishWorkerPreflight: (
      configuration: string,
      body: string,
      status?: number,
    ) => Promise<{ method: string; path: string }>;
  }
}

const encodeConfiguration = Schema.encodeSync(Schema.fromJsonString(ConfigurationView));
const withPreflight = (check: WorkerConfigurationView["prerequisites"]) =>
  new ConfigurationView({
    ...configuration,
    workers: configuration.workers.map((worker) =>
      worker.name === "eu-1"
        ? new WorkerConfigurationView({ ...worker, prerequisites: check })
        : worker,
    ),
  });
const preflightBody = (updated: ConfigurationView) => {
  const worker = updated.workers.find(({ name }) => name === "eu-1");
  if (worker === undefined) throw new Error("Missing worker");
  return JSON.stringify({
    worker: worker.name,
    prerequisites: worker.prerequisites,
    harnesses: worker.harnesses,
    containerLimits: worker.containerLimits,
  });
};

it("disables preflight for a busy worker and shows the reason", async () => {
  await mount("/configuration/workers");
  const busy = page.getByRole("button", { name: "Run preflight on local", exact: true });
  await expect.element(busy).toBeDisabled();
  await expect.element(busy).toHaveAccessibleDescription("Available after all attempts end");
  await expect
    .element(page.getByRole("button", { name: "Run preflight on eu-1", exact: true }))
    .toBeEnabled();
  queryClient.setQueryData(
    configurationQuery().queryKey,
    new ConfigurationView({
      ...configuration,
      workers: configuration.workers.map((worker) =>
        worker.name === "eu-1"
          ? new WorkerConfigurationView({ ...worker, preflightRunning: true })
          : worker,
      ),
    }),
  );
  const checking = page.getByRole("button", { name: "Run preflight on eu-1", exact: true });
  await expect.element(checking).toBeDisabled();
  await expect.element(checking).toHaveAccessibleDescription("A preflight is already running");
});

it("runs preflight from a worker row, refreshes failed checks and remediation, then passes after repair", async () => {
  const failed = withPreflight({
    _tag: "Failed",
    checkedAt: "2026-10-30T12:00:00Z",
    capability: "machine",
    message: "SSH destination is unreachable. Restore connectivity to the worker.",
  });
  await commands.workerPreflightResponses(encodeConfiguration(configuration));
  await mount("/configuration/workers", 390);
  const action = page.getByRole("button", { name: "Run preflight on eu-1", exact: true });
  await action.click();
  await expect.element(action).toBeDisabled();
  await expect.element(action).toHaveTextContent("Running preflight…");
  const request = await commands.finishWorkerPreflight(
    encodeConfiguration(failed),
    preflightBody(failed),
  );
  expect(request).toEqual({ method: "POST", path: "/api/workers/eu-1/preflight" });
  await expect.element(action).toBeEnabled();
  await expect.element(row(/eu-1/u).getByText("Failed", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "eu-1", exact: true }).click();
  await expect
    .element(
      page
        .getByText("SSH destination is unreachable. Restore connectivity to the worker.", {
          exact: true,
        })
        .first(),
    )
    .toBeVisible();
  const passed = withPreflight({ _tag: "Passed", checkedAt: "2026-10-30T12:01:00Z" });
  await commands.workerPreflightResponses(encodeConfiguration(failed));
  await action.click();
  await expect.element(action).toBeDisabled();
  await commands.finishWorkerPreflight(encodeConfiguration(passed), preflightBody(passed));
  await expect.element(page.getByRole("row", { name: /Worker.*Passed/u })).toBeVisible();
  await expect
    .element(
      page.getByText("SSH destination is unreachable. Restore connectivity to the worker.", {
        exact: true,
      }),
    )
    .not.toBeInTheDocument();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
});

it("shows a server busy refusal and keeps the last checks", async () => {
  await commands.workerPreflightResponses(encodeConfiguration(configuration));
  await mount("/configuration/workers/eu-1");
  const action = page.getByRole("button", { name: "Run preflight on eu-1", exact: true });
  await action.click();
  await commands.finishWorkerPreflight(
    encodeConfiguration(configuration),
    JSON.stringify({
      error: "WorkerPreflightRejectedError",
      message: "An attempt started on this worker. Try again after it ends.",
    }),
    409,
  );
  await expect
    .element(page.getByRole("alert").filter({ hasText: "An attempt started" }))
    .toBeVisible();
  await expect.element(action).toBeEnabled();
});
