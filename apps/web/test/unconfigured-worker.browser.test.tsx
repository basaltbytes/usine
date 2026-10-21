import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkerName } from "@usine/core/worker";
import { UnconfiguredWorkerNeed } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { NeedsYou } from "../src/needs-you/needs-you.tsx";
import { WithRouter } from "./memory-router.tsx";
import "../src/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    refuseDiscardLeftovers: (body: string) => Promise<void>;
  }
}

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

const removedWorker = (running: number) =>
  new UnconfiguredWorkerNeed({
    id: "unconfigured-worker:usine-worker-2",
    worker: WorkerName.make("usine-worker-2"),
    attempts: 3,
    running,
  });

const renderNeeds = (need: UnconfiguredWorkerNeed) =>
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <WithRouter>
          <NeedsYou needs={[need]} />
        </WithRouter>
      </QueryClientProvider>,
    ),
  );

const needs = () => page.getByRole("region", { name: "Needs attention" });

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

it("says how many attempts still run on a removed worker and offers no discard until they end", async () => {
  renderNeeds(removedWorker(2));
  await expect
    .element(
      needs().getByText(
        "usine-worker-2 is not in usine.yaml. 2 attempts still run on it; discard its leftovers once they end",
        { exact: true },
      ),
    )
    .toBeVisible();
  expect(needs().getByRole("button").elements()).toEqual([]);
});

it("offers Discard leftovers once no attempt runs on the worker, and shows why a discard is refused", async () => {
  await commands.refuseDiscardLeftovers(
    JSON.stringify({
      error: "LeftoversDiscardRejectedError",
      message: "1 attempt still runs on usine-worker-2; discard its leftovers once they end.",
    }),
  );
  renderNeeds(removedWorker(0));
  await expect
    .element(
      needs().getByText("Startup does not reconcile the 3 recorded attempts", { exact: false }),
    )
    .toBeVisible();
  await needs().getByRole("button", { name: "Discard leftovers", exact: true }).click();
  await needs().getByRole("button", { name: "Confirm discard", exact: true }).click();
  await expect
    .element(
      needs().getByText(
        "1 attempt still runs on usine-worker-2; discard its leftovers once they end.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect
    .element(needs().getByRole("button", { name: "Confirm discard", exact: true }))
    .toBeEnabled();
});
