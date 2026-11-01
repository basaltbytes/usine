import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { administratorPermissions } from "@usine/core/access";
import { ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { overviewQuery } from "~/lib/overview";
import { sessionQuery } from "~/lib/permissions";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

for (const initial of ["/", "/tokens", "revoked"]) {
  it(`keeps own tokens and sign-out usable without role bindings (${initial})`, async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    if (initial === "revoked") {
      client.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
      client.setQueryData(
        overviewQuery().queryKey,
        new ReadyOverview({ projects: [], loops: [], needsYou: [] }),
      );
    }
    const requests: string[] = [];
    let tokens = [
      { id: "device", name: "Laptop", createdAt: 0, lastUsedAt: 0, kind: "device", scopes: [] },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/auth/session") return Response.json({ permissions: [] });
      if (path === "/api/tokens") return Response.json(tokens);
      if (path === "/api/tokens/device" && init?.method === "DELETE") {
        tokens = [];
        return Response.json({ ok: true });
      }
      if (path === "/api/auth/sign-out")
        return Response.json({ message: "Sign-out test response" }, { status: 503 });
      return Response.json({ message: "Access denied" }, { status: 403 });
    };
    const router = createRouter({
      routeTree,
      context: { queryClient: client },
      history: createMemoryHistory({
        initialEntries: [initial === "revoked" ? "/tokens" : initial],
      }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await router.load();
      flushSync(() =>
        root.render(
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
        ),
      );
      if (initial === "revoked") {
        await expect.element(page.getByText("Laptop", { exact: true })).toBeVisible();
        await client.invalidateQueries(sessionQuery());
      }
      await expect.element(page.getByRole("navigation", { name: "Account" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      if (initial === "/") {
        await expect.element(page.getByText("No project access", { exact: true })).toBeVisible();
        await page.getByRole("link", { name: "Tokens", exact: true }).click();
      }
      await expect.element(page.getByText("Laptop", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Revoke", exact: true }).click();
      await page.getByRole("button", { name: "Confirm revocation" }).click();
      await expect.element(page.getByText("Laptop", { exact: true })).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect.element(page.getByText("Sign-out test response", { exact: true })).toBeVisible();
      expect(requests).toContain("DELETE /api/tokens/device");
      expect(requests).toContain("POST /api/auth/sign-out");
      expect(requests.some((request) => request.endsWith("/api/overview"))).toBe(false);
    } finally {
      flushSync(() => root.unmount());
      client.clear();
      host.remove();
      globalThis.fetch = originalFetch;
    }
  });
}
