import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import type { Page, Route } from "playwright";
import vite from "./vite.config.ts";

const delayedMoves = new WeakMap<Page, Promise<Route>>();

export default mergeConfig(
  vite,
  defineConfig({
    test: {
      // Keep browser layout tests from oversubscribing the monorepo test gate.
      maxWorkers: 2,
      attachmentsDir: "./node_modules/.cache/vitest/attachments",
      projects: [
        {
          extends: true,
          test: { name: "unit", exclude: [...configDefaults.exclude, "**/*.browser.test.tsx"] },
        },
        {
          extends: true,
          test: {
            name: "browser",
            include: ["test/**/*.browser.test.tsx"],
            browser: {
              enabled: true,
              headless: true,
              screenshotDirectory: "./node_modules/.cache/vitest/screenshots",
              provider: playwright(),
              commands: {
                delayBoardMove: async ({ page }) => {
                  let receive: (route: Route) => void;
                  const request = new Promise<Route>((resolve) => {
                    receive = resolve;
                  });
                  delayedMoves.set(page, request);
                  await page.unroute("**/api/projects/board-test/repo/items/*/lane");
                  await page.route("**/api/projects/board-test/repo/items/*/lane", (route) =>
                    receive(route),
                  );
                },
                releaseBoardMove: async ({ page }) => {
                  const request = delayedMoves.get(page);
                  if (request === undefined) throw new Error("No delayed Board move");
                  const route = await request;
                  await route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
                  delayedMoves.delete(page);
                },
                boardResponses: async ({ page }, overview: string, moveStatus: 200 | 503) => {
                  await page.unroute("**/api/overview");
                  await page.unroute("**/api/projects/board-test/repo/items/*/lane");
                  await page.route("**/api/overview", (route) =>
                    route.fulfill({ contentType: "application/json", body: overview }),
                  );
                  await page.route("**/api/projects/board-test/repo/items/*/lane", (route) =>
                    route.fulfill({
                      status: moveStatus,
                      contentType: "application/json",
                      body: JSON.stringify(
                        moveStatus === 200
                          ? { ok: true }
                          : { error: "BackendUnavailableError", message: "GitHub is unavailable" },
                      ),
                    }),
                  );
                },
              },
              instances: [{ browser: "chromium" }],
            },
          },
        },
      ],
    },
  }),
);
