import type { SetupState } from "@usine/orchestrator/operator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { SetupPage } from "./setup.page";
import { setupQuery, activateInstance } from "./queries";
import "~/index.css";

it.each([
  { device: "desktop", width: 1440, height: 900, theme: "dark" },
  { device: "desktop", width: 1440, height: 900, theme: "light" },
  { device: "phone", width: 390, height: 844, theme: "dark" },
  { device: "phone", width: 390, height: 844, theme: "light" },
])(
  "walks setup through all states on $device in $theme with a fake backend",
  async ({ device, width, height, theme }) => {
    await page.viewport(width, height);
    document.documentElement.classList.toggle("dark", theme === "dark");
    await commands.reducedMotion(true);
    const capture = async (state: string) => {
      await document.fonts.ready;
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await commands.configurationEditorScreenshot(`779-${state}-${device}-${theme}`);
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let state: SetupState = { _tag: "NoApp" };
    const originalFetch = globalThis.fetch;
    const submitted: string[] = [];
    let runtimeChecks = 0;
    const stopNavigation = (event: SubmitEvent) => {
      if (
        event.target instanceof HTMLFormElement &&
        event.target.action.startsWith("https://github.com/")
      ) {
        event.preventDefault();
        submitted.push(event.target.action);
      }
    };
    document.addEventListener("submit", stopNavigation);
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/activate")) return Response.json({ ok: true });
      if (String(input).endsWith("/runtime")) {
        runtimeChecks += 1;
        if (runtimeChecks === 1) throw new TypeError("Server is restarting");
        return Response.json({ ready: runtimeChecks >= 3 });
      }
      if (String(input).endsWith("/manifest")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          name: "usine-test",
          organization: "acme",
        });
        state = { _tag: "MissingKey", message: "The App key was not saved." };
        return Response.json({
          action: "https://github.com/organizations/acme/settings/apps/new?state=test",
          manifest: "{}",
        });
      }
      if (String(input).endsWith("/restore")) {
        state = {
          _tag: "NeedsInstallation",
          url: "https://github.com/apps/usine-test/installations/new",
          message: "No installation found.",
        };
        return Response.json({ ok: true });
      }
      return Response.json(state);
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(
          <QueryClientProvider client={client}>
            <Suspense fallback={null}>
              <SetupPage />
            </Suspense>
          </QueryClientProvider>,
        ),
      );
      await expect
        .element(page.getByRole("heading", { name: "Create your GitHub App" }))
        .toBeVisible();
      await capture("no-app");
      await page.getByLabelText("App name").fill("usine-test");
      await page.getByLabelText("Organization (optional)").fill("acme");
      await page.getByRole("button", { name: "Create App on GitHub" }).click();
      await expect.poll(() => submitted.length).toBe(1);
      await client.invalidateQueries(setupQuery());
      await expect
        .element(page.getByRole("heading", { name: "Recover your GitHub App" }))
        .toBeVisible();
      await capture("missing-key");
      await page.getByLabelText("Credential JSON").fill('{"app_id":123,"private_key":"restored"}');
      await page.getByRole("button", { name: "Save credentials" }).click();
      await expect
        .element(page.getByRole("heading", { name: "Install your GitHub App" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Install App on GitHub" }))
        .toHaveAttribute("href", "https://github.com/apps/usine-test/installations/new");
      await capture("no-installation");
      state = { _tag: "Repositories", signIn: true, github: true };
      await page.getByRole("button", { name: "Check installation" }).click();
      await expect
        .element(page.getByRole("button", { name: "Sign in with GitHub" }))
        .toHaveAttribute("href", "/api/auth/github");
      await capture("empty-registry");
      state = { _tag: "Repositories", signIn: false, github: true };
      await client.invalidateQueries(setupQuery());
      await expect.element(page.getByRole("button", { name: "Add repositories" })).toBeVisible();
      await capture("repository-handoff");
      await activateInstance();
      expect(runtimeChecks).toBe(3);
      state = { _tag: "Ready" };
      await client.invalidateQueries(setupQuery());
      await expect.element(page.getByRole("button", { name: "Open usine" })).toBeVisible();
    } finally {
      flushSync(() => root.unmount());
      client.clear();
      host.remove();
      globalThis.fetch = originalFetch;
      document.removeEventListener("submit", stopNavigation);
      document.documentElement.classList.remove("dark");
      await commands.reducedMotion(false);
    }
  },
);
