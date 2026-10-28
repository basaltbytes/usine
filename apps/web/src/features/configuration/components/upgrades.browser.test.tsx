import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReleaseVersion, UpgradeRecord, type UpgradeTiming } from "@usine/core/upgrade";
import { UpgradeView } from "@usine/orchestrator/operator/http";
import { Schema } from "effect";
import { Suspense } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { upgradeQuery } from "~/features/configuration/queries";
import { Upgrades } from "./upgrades";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    upgradeResponses: (
      initial: string,
      after: string,
      timing: string,
      rejection: string,
    ) => Promise<void>;
  }
}

const available = new UpgradeView({
  running: "1.0.1-next.41.gabcdef0",
  channel: "next",
  mode: "propose",
  supported: true,
  available: ReleaseVersion.make("1.0.1-next.42.g1234567"),
  phase: "idle",
  message: null,
  outcome: null,
});
const json = Schema.encodeSync(Schema.fromJsonString(UpgradeView));

it.each(["idle", "now"] satisfies ReadonlyArray<UpgradeTiming>)(
  "requests the %s upgrade and shows progress on desktop and mobile",
  async (timing) => {
    const progress = new UpgradeView({
      ...available,
      phase: timing === "idle" ? "waiting" : "installing",
    });
    await commands.upgradeResponses(json(available), json(progress), timing, "");
    const host = document.createElement("div");
    host.className = "dark bg-background text-foreground p-6";
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(upgradeQuery().queryKey, available);
    try {
      flushSync(() =>
        root.render(
          <QueryClientProvider client={client}>
            <Suspense>
              <Upgrades />
            </Suspense>
          </QueryClientProvider>,
        ),
      );
      for (const width of [1280, 390]) {
        await page.viewport(width, 900);
        await expect.element(page.getByRole("button", { name: "Upgrade when idle" })).toBeVisible();
        expect(host.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
      }
      await expect
        .element(page.getByRole("link", { name: "View changes" }))
        .toHaveAttribute("href", "https://github.com/basaltbytes/usine/compare/abcdef0...1234567");
      await page
        .getByRole("button", {
          name: timing === "idle" ? "Upgrade when idle" : "Upgrade now",
          exact: true,
        })
        .click();
      await expect
        .element(
          page.getByText(
            timing === "idle"
              ? "Waiting for running attempts to finish. No new attempts will start."
              : "Installing and restarting. This page reconnects when the server answers.",
            { exact: true },
          ),
        )
        .toBeVisible();
    } finally {
      flushSync(() => root.unmount());
      client.clear();
      host.remove();
    }
  },
);

it("keeps the rollback reason visible and explains a refused retry", async () => {
  const rolledBack = new UpgradeView({
    ...available,
    outcome: UpgradeRecord.make({
      previous: ReleaseVersion.make(available.running),
      target: ReleaseVersion.make("1.0.1-next.42.g1234567"),
      status: "rolled-back",
      reason: "The new API did not answer.",
      failureStage: "health-check",
    }),
  });
  await commands.upgradeResponses(
    json(rolledBack),
    json(rolledBack),
    "idle",
    "Install usine-upgrade.service before upgrading.",
  );
  const host = document.createElement("div");
  host.className = "dark bg-background text-foreground p-6";
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(upgradeQuery().queryKey, rolledBack);
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Suspense>
            <Upgrades />
          </Suspense>
        </QueryClientProvider>,
      ),
    );
    await expect.element(page.getByText(/Restored 1.0.1-next.41.gabcdef0/)).toBeVisible();
    await page.getByRole("button", { name: "Upgrade when idle" }).click();
    await expect
      .element(page.getByText("Install usine-upgrade.service before upgrading."))
      .toBeVisible();
  } finally {
    flushSync(() => root.unmount());
    client.clear();
    host.remove();
  }
});
