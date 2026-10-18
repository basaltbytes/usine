import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import type { Page, Route } from "playwright";
import vite from "./vite.config.ts";

// Set on Workers built by infra/hetzner/cloud-init.yaml, which have Debian's Chromium instead of Playwright's.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const delayedMoves = new WeakMap<Page, Promise<Route>>();
const interventionRequests = new WeakMap<Page, Array<{ url: string; body: unknown }>>();

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
              provider: playwright(
                executablePath === undefined ? {} : { launchOptions: { executablePath } },
              ),
              commands: {
                failureResolutionResponses: async (
                  { page },
                  before: string,
                  after: string,
                  detailBefore: string,
                  detailAfter: string,
                  attemptId: string,
                ) => {
                  let resolved = false;
                  await page.route("**/api/overview", (route) =>
                    route.fulfill({
                      contentType: "application/json",
                      body: resolved ? after : before,
                    }),
                  );
                  await page.route("**/api/runs/resolution-run", (route) =>
                    route.fulfill({
                      contentType: "application/json",
                      body: resolved ? detailAfter : detailBefore,
                    }),
                  );
                  await page.route("**/api/runs/resolution-run/resolve-failure", (route) => {
                    if (route.request().postDataJSON().attemptId !== attemptId)
                      return route.fulfill({ status: 409 });
                    resolved = true;
                    return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
                  });
                  await page.route("**/api/runs/resolution-run/retry", (route) =>
                    route.fulfill({
                      status: 409,
                      contentType: "application/json",
                      body: JSON.stringify({
                        error: "RunRetryBlockedError",
                        message:
                          "Cannot retry Run resolution-run: Run newer-run of Loop implement is open on the same Item. Retry after it closes, or cancel it first.",
                      }),
                    }),
                  );
                },
                reloadResponses: async (
                  { page },
                  before: string,
                  after: string,
                  report: string,
                  rejection: string,
                ) => {
                  let reloads = 0;
                  await page.unroute("**/api/overview");
                  await page.route("**/api/overview", (route) =>
                    route.fulfill({
                      contentType: "application/json",
                      body: reloads === 0 ? before : after,
                    }),
                  );
                  await page.route("**/api/instance/reload", (route) => {
                    reloads += 1;
                    return route.fulfill(
                      reloads === 1
                        ? { contentType: "application/json", body: report }
                        : { status: 422, contentType: "application/json", body: rejection },
                    );
                  });
                },
                interventionResponses: async ({ page }, status: 200 | 503) => {
                  interventionRequests.set(page, []);
                  await page.unroute("**/api/agents");
                  await page.unroute("**/api/runs/intervention-test/*");
                  await page.route("**/api/agents", (route) =>
                    route.fulfill({
                      contentType: "application/json",
                      body: '["developer","reviewer"]',
                    }),
                  );
                  await page.route("**/api/runs/intervention-test/*", async (route) => {
                    interventionRequests
                      .get(page)
                      ?.push({ url: route.request().url(), body: route.request().postDataJSON() });
                    await route.fulfill({
                      status,
                      contentType: "application/json",
                      body: JSON.stringify(
                        status === 200
                          ? { ok: true }
                          : { error: "BackendUnavailableError", message: "Worker is disconnected" },
                      ),
                    });
                  });
                },
                recordedInterventions: async ({ page }) => interventionRequests.get(page) ?? [],
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
