import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { ProviderConnections } from "./connections";
import { timestampLabel } from "~/lib/strings";
import type { ProviderConnection, ProviderStatus } from "@usine/gateway/credentials";
import "~/index.css";

const expiry = "2027-01-01T00:00:00Z";
const refreshed = "2026-11-01T12:00:00Z";
const cases: ReadonlyArray<{
  readonly name: string;
  readonly connection: ProviderConnection;
  readonly expectedTimes: readonly string[];
  readonly manualReplacement: boolean;
}> = [
  {
    name: "Claude setup token",
    connection: {
      provider: "anthropic-messages",
      credential: "subscription",
      expiresAt: null,
      lastRefresh: null,
      refreshable: false,
    },
    expectedTimes: ["Not included with token", "Not applicable"],
    manualReplacement: true,
  },
  {
    name: "native Claude OAuth login",
    connection: {
      provider: "anthropic-messages",
      credential: "subscription",
      expiresAt: expiry,
      lastRefresh: null,
    },
    expectedTimes: [timestampLabel(expiry), "Not reported"],
    manualReplacement: false,
  },
  {
    name: "ChatGPT OAuth login",
    connection: {
      provider: "openai-responses",
      credential: "subscription",
      expiresAt: expiry,
      lastRefresh: refreshed,
      refreshable: true,
    },
    expectedTimes: [timestampLabel(expiry), timestampLabel(refreshed)],
    manualReplacement: false,
  },
  {
    name: "refreshable login without dates",
    connection: {
      provider: "openai-responses",
      credential: "subscription",
      expiresAt: null,
      lastRefresh: null,
      refreshable: true,
    },
    expectedTimes: ["Not reported", "Not reported"],
    manualReplacement: false,
  },
  {
    name: "older gateway without refresh metadata",
    connection: {
      provider: "anthropic-messages",
      credential: "subscription",
      expiresAt: null,
      lastRefresh: null,
    },
    expectedTimes: ["Not reported", "Not reported"],
    manualReplacement: false,
  },
];

it.each(cases)(
  "explains dates for $name",
  async ({ connection, expectedTimes, manualReplacement }) => {
    await page.viewport(390, 844);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const state: ProviderStatus = {
      targets: [{ target: "gateway", label: "usine-gateway", providers: [connection] }],
      logins: [],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(state);
    const host = document.createElement("div");
    host.className = "mx-auto max-w-3xl bg-background p-5 text-foreground";
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(
          <QueryClientProvider client={client}>
            <ProviderConnections />
          </QueryClientProvider>,
        ),
      );
      await expect.element(page.getByRole("button", { name: /Replace .* login/u })).toBeVisible();
      expect(Array.from(host.querySelectorAll("dd"), (cell) => cell.textContent)).toEqual(
        expectedTimes,
      );
      expect(host.textContent?.includes("Replace the login before it expires.")).toBe(
        manualReplacement,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    } finally {
      root.unmount();
      host.remove();
      client.clear();
      globalThis.fetch = originalFetch;
    }
  },
);
