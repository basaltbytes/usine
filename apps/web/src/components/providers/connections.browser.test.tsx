import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { ProviderConnections } from "./connections";
import type { ProviderStatus } from "@usine/gateway/credentials";
import "~/index.css";

it.each([
  { width: 1280, height: 900, device: "desktop" },
  { width: 390, height: 844, device: "phone" },
])(
  "connects, cancels, and replaces provider credentials on $device",
  async ({ width, height, device }) => {
    await page.viewport(width, height);
    document.documentElement.classList.add("dark");
    await commands.reducedMotion(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let state: ProviderStatus = {
      targets: [
        {
          target: "gateway",
          label: "usine-gateway",
          providers: [
            { provider: "anthropic", credential: null, expiresAt: null, lastRefresh: null },
            {
              provider: "openai",
              credential: "subscription",
              expiresAt: "2027-01-01T00:00:00Z",
              lastRefresh: "2026-11-01T12:00:00Z",
            },
          ],
        },
      ],
      logins: [],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/login") && init?.method === "POST") {
        const login = {
          id: "login",
          target: "gateway",
          provider: "claude" as const,
          state: {
            status: "authorizing" as const,
            url: "https://claude.com/cai/oauth/authorize?code=true",
            code: null,
          },
        };
        state = { ...state, logins: [login] };
        return Response.json(login);
      }
      if (init?.method === "DELETE") {
        state = {
          ...state,
          logins: [
            { id: "login", target: "gateway", provider: "claude", state: { status: "cancelled" } },
          ],
        };
        return Response.json({ ok: true });
      }
      if (url.endsWith("/key")) {
        state = {
          ...state,
          targets: state.targets.map((target) =>
            "error" in target
              ? target
              : {
                  ...target,
                  providers: target.providers.map((provider) =>
                    provider.provider === "anthropic"
                      ? { ...provider, credential: "api-key" }
                      : provider,
                  ),
                },
          ),
        };
        return Response.json({ ok: true });
      }
      return Response.json(state);
    };
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
      await expect
        .element(page.getByRole("button", { name: "Connect Claude", exact: true }))
        .toBeVisible();
      await document.fonts.ready;
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await commands.configurationEditorScreenshot(`960-providers-${device}`);
      state = {
        ...state,
        targets: [
          {
            target: "unavailable",
            label: "Unavailable gateway",
            error: "Check gateway SSH access.",
          },
          ...state.targets,
        ],
      };
      await client.invalidateQueries();
      await expect.element(page.getByText("Check gateway SSH access.")).toBeVisible();
      await page.getByRole("button", { name: "Connect Claude", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Open sign-in page" })).toBeVisible();
      await expect.element(page.getByLabelText("Code from Claude")).toBeVisible();
      await commands.configurationEditorScreenshot(`960-authorizing-${device}`);
      await page.getByRole("button", { name: "Cancel sign-in" }).click();
      await expect
        .element(page.getByText("Sign-in cancelled. You can connect again."))
        .toBeVisible();
      const details = host.querySelector("details");
      if (details === null) throw new Error("API-key form missing");
      details.open = true;
      await page.getByLabelText("API key", { exact: true }).first().fill("private-test-api-key");
      await page.getByRole("button", { name: "Save API key", exact: true }).first().click();
      await expect.element(page.getByText("Connected · API key", { exact: true })).toBeVisible();
      await expect.element(page.getByLabelText("API key", { exact: true }).first()).toHaveValue("");
      expect(host.textContent).not.toContain("private-test-api-key");
    } finally {
      root.unmount();
      host.remove();
      client.clear();
      globalThis.fetch = originalFetch;
    }
  },
);
