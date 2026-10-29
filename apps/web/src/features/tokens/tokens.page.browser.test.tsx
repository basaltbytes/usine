import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { PageCommandsProvider } from "~/components/command-palette/context";
import { CommandPalette } from "~/components/command-palette/palette";
import { WithRouter } from "~/lib/testing/memory-router";
import { TokensPage } from "./tokens.page";
import { tokensQuery } from "./queries";
import "~/index.css";

it("distinguishes tokens with the same name and confirms revocation through the page control", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  let tokens = ["first", "second"].map((id) => ({
    id,
    name: "Laptop",
    createdAt: 0,
    lastUsedAt: 0,
    kind: "browser",
  }));
  client.setQueryData(tokensQuery().queryKey, tokens);
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "GET") return Response.json(tokens);
    requests.push(`${init?.method} ${input}`);
    tokens = tokens.filter(({ id }) => id !== "second");
    return Response.json({ ok: true });
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <WithRouter>
            <PageCommandsProvider>
              <CommandPalette
                overview={new ReadyOverview({ projects: [], loops: [], needsYou: [] })}
              />
              <TokensPage />
            </PageCommandsProvider>
          </WithRouter>
        </QueryClientProvider>,
      ),
    );
    await page.getByRole("button", { name: "Open commands" }).click();
    await page.getByRole("combobox").fill("Revoke");
    await expect
      .element(page.getByRole("option", { name: "Revoke · Laptop · first", exact: true }))
      .toBeVisible();
    await page.getByRole("option", { name: "Revoke · Laptop · second", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Confirm revocation" })).toBeVisible();
    expect(requests).toEqual([]);
    await page.getByRole("button", { name: "Keep token" }).click();
    await page.getByRole("button", { name: "Open commands" }).click();
    await page.getByRole("combobox").fill("Revoke second");
    await page.getByRole("option", { name: "Revoke · Laptop · second", exact: true }).click();
    await page.getByRole("button", { name: "Confirm revocation" }).click();
    await expect.poll(() => requests).toEqual(["DELETE /api/tokens/second"]);
    await page.getByRole("button", { name: "Open commands" }).click();
    await page.getByRole("combobox").fill("Revoke");
    await expect
      .element(page.getByRole("option", { name: "Revoke · Laptop · second", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("option", { name: "Revoke · Laptop · first", exact: true }))
      .toBeVisible();
  } finally {
    flushSync(() => root.unmount());
    client.clear();
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
