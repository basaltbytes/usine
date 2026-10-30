import {
  workerPreflightResponses,
  finishWorkerPreflight,
} from "./src/features/configuration/components/workers/browser-fixture.ts";
import { signInResponses } from "./src/features/sign-in/browser-fixture.ts";
import { loopEditorResponses } from "./src/features/configuration/components/forms/loop/browser-fixture.ts";
import {
  delayConfigurationLookup,
  releaseConfigurationLookup,
  configurationEditorResponses,
  configurationEditorScreenshot,
  configurationEditorRequests,
} from "./src/features/configuration/components/editor/browser-fixture.ts";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import type { Page, Route } from "playwright";
import vite from "./vite.config.ts";

// Set on Workers from infra/hetzner/cloud-init.yaml, which use Debian's Chromium, not Playwright's.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const boardMoveRequests = new WeakMap<Page, Array<{ url: string; body: unknown }>>();
const delayedMoves = new WeakMap<Page, Promise<Route>>();
const delayedRunAgains = new WeakMap<Page, Promise<Route>>();
const interventionRequests = new WeakMap<
  Page,
  Array<{ url: string; body: unknown; headers: Array<string> }>
>();

/** The approve request that `approvalResponses` delays until `answerApproval`, and the requests after it. */
interface ApprovalExchange {
  readonly request: Promise<Route>;
  /** Whether the approve request was answered; if so, the stubs serve the approved state. */
  answered: boolean;
  /** The number of overview requests received after the approve request was answered. */
  lateOverviews: number;
}
const approvals = new WeakMap<Page, ApprovalExchange>();
/** The `window` of each task and run statistics request, in arrival order. */
interface StatisticsRequests {
  readonly tasks: Array<string | null>;
  readonly runs: Array<string | null>;
}
interface TranscriptExchange {
  readonly earlier: Promise<Route>;
  readonly earlierBody: string;
  readonly requests: Array<{ after: string | null; before: string | null; attempt: string | null }>;
}
const transcriptExchanges = new WeakMap<Page, TranscriptExchange>();
const delayedStatistics = new WeakMap<Page, { window: string; releases: Array<() => void> }>();
const statisticsWindows = new WeakMap<Page, StatisticsRequests>();
// The overview response delay after approval, as on a busy instance (#463).
const SLOW_OVERVIEW_MS = 5_000;

export default mergeConfig(
  vite,
  defineConfig({
    test: {
      // Limits browser test workers so they do not oversubscribe the monorepo test run.
      maxWorkers: 2,
      attachmentsDir: "./node_modules/.cache/vitest/attachments",
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            include: ["src/**/*.test.{ts,tsx}"],
            exclude: [...configDefaults.exclude, "**/*.browser.test.tsx"],
          },
        },
        {
          extends: true,
          // A dependency cache from an earlier tree can pass the hash check without a dependency
          // these tests import; bundling it mid-run reloads the page under the tests.
          optimizeDeps: { force: true },
          test: {
            name: "browser",
            include: ["src/**/*.browser.test.tsx"],
            // Locator actions wait up to the test timeout; Chromium is slow on a busy machine.
            testTimeout: 30_000,
            // Hooks that render a page load its route code, which is as slow.
            hookTimeout: 30_000,
            browser: {
              enabled: true,
              headless: true,
              screenshotDirectory: "./node_modules/.cache/vitest/screenshots",
              provider: playwright(
                executablePath === undefined ? {} : { launchOptions: { executablePath } },
              ),
              commands: {
                workerPreflightResponses,
                finishWorkerPreflight,
                signInResponses,
                loopEditorResponses,
                delayConfigurationLookup,
                releaseConfigurationLookup,
                configurationEditorResponses,
                configurationEditorRequests,
                configurationEditorScreenshot,
                reducedMotion: async ({ page }, reduce: boolean) => {
                  await page.emulateMedia({ reducedMotion: reduce ? "reduce" : "no-preference" });
                },
                taskListAvatarResponse: async ({ page }) => {
                  await page.unroute("https://github.com/board-test.png?*");
                  await page.route("https://github.com/board-test.png?*", (route) =>
                    route.fulfill({ status: 404, body: "" }),
                  );
                },
                attentionResponses: async ({ page }, before: string, after: string) => {
                  let dismissed = false;
                  await page.route("**/api/overview", (route) =>
                    route.fulfill({
                      contentType: "application/json",
                      body: dismissed ? after : before,
                    }),
                  );
                  await page.route("**/api/attention/*", (route) => {
                    dismissed = route.request().url().endsWith("/dismiss");
                    return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
                  });
                },
                loaderTranscriptResponses: async (
                  { page },
                  bodies: Readonly<
                    Record<"cold" | "tail" | "empty" | "earlier" | "oldest", string>
                  >,
                ) => {
                  let receive: (route: Route) => void;
                  const exchange: TranscriptExchange = {
                    earlier: new Promise<Route>((resolve) => {
                      receive = resolve;
                    }),
                    earlierBody: bodies.earlier,
                    requests: [],
                  };
                  transcriptExchanges.set(page, exchange);
                  await page.route("**/api/runs/loader-run/github-changes", (route) =>
                    route.fulfill({ contentType: "application/json", body: '{"attempts":[]}' }),
                  );
                  await page.route("**/api/runs/loader-run?*", async (route) => {
                    const url = new URL(route.request().url());
                    const after = url.searchParams.get("after");
                    const before = url.searchParams.get("before");
                    exchange.requests.push({
                      after,
                      before,
                      attempt: url.searchParams.get("attempt"),
                    });
                    if (before === "3") return receive(route);
                    const body =
                      before === "2" ? bodies.oldest : after === "4" ? bodies.tail : bodies.empty;
                    await route.fulfill({ contentType: "application/json", body });
                  });
                  await page.route("**/api/runs/loader-run", (route) => {
                    exchange.requests.push({ after: null, before: null, attempt: null });
                    return route.fulfill({ contentType: "application/json", body: bodies.cold });
                  });
                },
                releaseEarlierTranscript: async ({ page }) => {
                  const exchange = transcriptExchanges.get(page);
                  if (exchange === undefined)
                    throw new Error("No earlier transcript request configured");
                  const route = await exchange.earlier;
                  await route.fulfill({
                    contentType: "application/json",
                    body: exchange.earlierBody,
                  });
                },
                loaderTranscriptRequests: async ({ page }) =>
                  transcriptExchanges.get(page)?.requests ?? [],
                failureResolutionResponses: async (
                  { page },
                  before: string,
                  after: string,
                  detailBefore: string,
                  detailAfter: string,
                  attemptId: string,
                ) => {
                  let resolved = false;
                  await page.route("**/api/desk", (route) =>
                    route.fulfill({
                      contentType: "application/json",
                      body: '{"running":[],"notMoving":[],"lastOutcomes":[],"workers":[],"polls":[]}',
                    }),
                  );
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
                  await page.route("**/api/projects/resolution/project/tasks/*", (route) =>
                    route.fulfill({
                      status: 404,
                      contentType: "application/json",
                      body: '{"error":"BoardItemNotFoundError","message":"Task not found"}',
                    }),
                  );
                  await page.route("**/api/runs/resolution-run/retry", (route) =>
                    route.fulfill({
                      status: 409,
                      contentType: "application/json",
                      body: JSON.stringify({
                        error: "RunRetryBlockedError",
                        message:
                          'Cannot retry run resolution-run: run newer-run of loop "implement" is open on the same item. Cancel run newer-run, or try again after it closes.',
                      }),
                    }),
                  );
                },
                upgradeResponses: async (
                  { page },
                  initial: string,
                  after: string,
                  timing: string,
                  rejection: string,
                ) => {
                  let current = initial;
                  await page.unroute("**/api/upgrade");
                  await page.route("**/api/upgrade", (route) => {
                    if (route.request().method() === "GET")
                      return route.fulfill({ contentType: "application/json", body: current });
                    const accepted =
                      route.request().postDataJSON().timing === timing && rejection === "";
                    if (accepted) current = after;
                    return route.fulfill({
                      status: accepted ? 200 : 409,
                      contentType: "application/json",
                      body: accepted
                        ? '{"ok":true}'
                        : JSON.stringify({
                            error: "UpgradeError",
                            message: rejection || "Unexpected upgrade timing",
                          }),
                    });
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
                    interventionRequests.get(page)?.push({
                      url: route.request().url(),
                      body: route.request().postDataJSON(),
                      headers: Object.keys(await route.request().allHeaders()),
                    });
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
                // Replaces the run-again route that `interventionResponses` registers.
                runAgainResponse: async ({ page }, body: string) => {
                  await page.unroute("**/api/runs/intervention-test/run-again");
                  await page.route("**/api/runs/intervention-test/run-again", async (route) => {
                    interventionRequests.get(page)?.push({
                      url: route.request().url(),
                      body: route.request().postDataJSON(),
                      headers: Object.keys(await route.request().allHeaders()),
                    });
                    await route.fulfill({ contentType: "application/json", body });
                  });
                },
                recordedInterventions: async ({ page }) => interventionRequests.get(page) ?? [],
                // Serves Run `approval-run` waiting for approval: `before` and `detailBefore` until
                // `answerApproval` answers the delayed approve request, then `detailAfter` and
                // `after`, with the overview delayed by 5 s.
                approvalResponses: async (
                  { page },
                  before: string,
                  after: string,
                  detailBefore: string,
                  detailAfter: string,
                ) => {
                  let receive: (route: Route) => void;
                  const exchange: ApprovalExchange = {
                    request: new Promise<Route>((resolve) => {
                      receive = resolve;
                    }),
                    answered: false,
                    lateOverviews: 0,
                  };
                  approvals.set(page, exchange);
                  await page.unroute("**/api/desk");
                  await page.unroute("**/api/overview");
                  await page.unroute("**/api/runs/approval-run");
                  await page.unroute("**/api/runs/approval-run/approve");
                  await page.route("**/api/desk", (route) =>
                    route.fulfill({
                      contentType: "application/json",
                      body: '{"running":[],"notMoving":[],"lastOutcomes":[],"workers":[],"polls":[]}',
                    }),
                  );
                  await page.route("**/api/overview", async (route) => {
                    if (!exchange.answered)
                      return route.fulfill({ contentType: "application/json", body: before });
                    exchange.lateOverviews += 1;
                    await new Promise((resolve) => setTimeout(resolve, SLOW_OVERVIEW_MS));
                    return route.fulfill({ contentType: "application/json", body: after });
                  });
                  await page.route("**/api/runs/approval-run", (route) =>
                    route.fulfill({
                      contentType: "application/json",
                      body: exchange.answered ? detailAfter : detailBefore,
                    }),
                  );
                  await page.route("**/api/runs/approval-run/approve", (route) => receive(route));
                },
                // Answers the delayed approve request with `status` and `body`.
                answerApproval: async ({ page }, status: 200 | 409, body: string) => {
                  const exchange = approvals.get(page);
                  if (exchange === undefined) throw new Error("No approval stubbed");
                  const route = await exchange.request;
                  exchange.answered = true;
                  await route.fulfill({ status, contentType: "application/json", body });
                },
                lateOverviewRequests: async ({ page }) => approvals.get(page)?.lateOverviews ?? 0,
                githubChangesResponse: async ({ page }, body: string) => {
                  await page.unroute("**/api/runs/*/github-changes");
                  await page.route("**/api/runs/*/github-changes", (route) =>
                    route.fulfill({ contentType: "application/json", body }),
                  );
                },
                delayBoardMove: async ({ page }) => {
                  let receive: (route: Route) => void;
                  const request = new Promise<Route>((resolve) => {
                    receive = resolve;
                  });
                  delayedMoves.set(page, request);
                  await page.unroute("**/api/projects/board-test/*/items/*/lane");
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
                // Delays the next Run again request of any Run until `releaseRunAgain`.
                delayRunAgain: async ({ page }) => {
                  let receive: (route: Route) => void;
                  const request = new Promise<Route>((resolve) => {
                    receive = resolve;
                  });
                  delayedRunAgains.set(page, request);
                  await page.unroute("**/api/runs/*/run-again");
                  await page.route("**/api/runs/*/run-again", (route) => receive(route));
                },
                // Answers the delayed request with `status` and `body`, returning path and payload.
                releaseRunAgain: async ({ page }, status: 200 | 409, body: string) => {
                  const request = delayedRunAgains.get(page);
                  if (request === undefined) throw new Error("No delayed Run again");
                  const route = await request;
                  await route.fulfill({ status, contentType: "application/json", body });
                  delayedRunAgains.delete(page);
                  await page.unroute("**/api/runs/*/run-again");
                  return {
                    path: new URL(route.request().url()).pathname,
                    body: route.request().postDataJSON(),
                  };
                },
                // Answers every Discard leftovers request with the error `body`.
                refuseDiscardLeftovers: async ({ page }, body: string) => {
                  await page.unroute("**/api/workers/*/discard-leftovers");
                  await page.route("**/api/workers/*/discard-leftovers", (route) =>
                    route.fulfill({ status: 409, contentType: "application/json", body }),
                  );
                },
                // Serves the overview, the desk, and the task and run statistics of each window,
                // and records the `window` of each statistics request.
                statisticsResponses: async (
                  { page },
                  overview: string,
                  desk: string,
                  statistics: Readonly<Record<"7d" | "30d" | "all", string>>,
                  runStatistics: Readonly<Record<"7d" | "30d" | "all", string>>,
                ) => {
                  const requests: StatisticsRequests = { tasks: [], runs: [] };
                  statisticsWindows.set(page, requests);
                  await page.unroute("**/api/overview");
                  await page.unroute("**/api/desk");
                  await page.unroute("**/api/statistics*");
                  await page.unroute("**/api/statistics/runs*");
                  await page.route("**/api/overview", (route) =>
                    route.fulfill({ contentType: "application/json", body: overview }),
                  );
                  await page.route("**/api/desk", (route) =>
                    route.fulfill({ contentType: "application/json", body: desk }),
                  );
                  const serve =
                    (
                      bodies: Readonly<Record<"7d" | "30d" | "all", string>>,
                      windows: Array<string | null>,
                    ) =>
                    async (route: Route) => {
                      const window = new URL(route.request().url()).searchParams.get("window");
                      windows.push(window);
                      const delayed = delayedStatistics.get(page);
                      if (delayed !== undefined && delayed.window === window) {
                        await new Promise<void>((resolve) => delayed.releases.push(resolve));
                      }
                      return route.fulfill(
                        window === "7d" || window === "30d" || window === "all"
                          ? { contentType: "application/json", body: bodies[window] }
                          : { status: 400 },
                      );
                    };
                  await page.route("**/api/statistics*", serve(statistics, requests.tasks));
                  await page.route("**/api/statistics/runs*", serve(runStatistics, requests.runs));
                },
                delayStatistics: async ({ page }, window: string) => {
                  delayedStatistics.set(page, { window, releases: [] });
                },
                releaseStatistics: async ({ page }) => {
                  const delayed = delayedStatistics.get(page);
                  delayedStatistics.delete(page);
                  for (const release of delayed?.releases ?? []) release();
                },
                statisticsRequests: async ({ page }) =>
                  statisticsWindows.get(page) ?? { tasks: [], runs: [] },
                boardMoveRequests: async ({ page }) => boardMoveRequests.get(page) ?? [],
                boardResponses: async ({ page }, overview: string, moveStatus: 200 | 503) => {
                  await page.unroute("**/api/overview");
                  await page.unroute("**/api/projects/board-test/*/items/*/lane");
                  await page.route("**/api/overview", (route) =>
                    route.fulfill({ contentType: "application/json", body: overview }),
                  );
                  const requests: Array<{ url: string; body: unknown }> = [];
                  boardMoveRequests.set(page, requests);
                  await page.route("**/api/projects/board-test/*/items/*/lane", (route) => {
                    requests.push({
                      url: route.request().url(),
                      body: route.request().postDataJSON(),
                    });
                    return route.fulfill({
                      status: moveStatus,
                      contentType: "application/json",
                      body: JSON.stringify(
                        moveStatus === 200
                          ? { ok: true }
                          : { error: "BackendUnavailableError", message: "GitHub is unavailable" },
                      ),
                    });
                  });
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
