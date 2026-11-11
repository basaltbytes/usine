import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { CommitSha } from "@usine/core/repository";
import { ChangedFile, FileChanges } from "@usine/github/file-changes";
import {
  TaskAttemptChangesView,
  TaskItemView,
  TaskPullRequestState,
} from "@usine/orchestrator/operator";
import { administratorPermissions } from "@usine/core/access";
import { PermissionsContext, sessionQuery } from "~/lib/permissions";
import { ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import {
  FactoryOverview,
  ProjectView,
  ReadyOverview,
  TaskView,
} from "@usine/orchestrator/operator";
import { Array as EffectArray, Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { taskQuery } from "~/lib/tasks/queries";
import { routeTree } from "~/route-tree.gen";
import { overviewQuery } from "~/lib/overview";
import { fullTask, quietTask, taskOverview, taskRepository } from "~/lib/tasks/fixture";
import "~/index.css";

interface Sent {
  readonly method: string;
  readonly path: string;
}

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let router: ReturnType<typeof createRouter<typeof routeTree>>;
let sent: Array<Sent>;
let tasks: Map<string, TaskView>;
let taskUnavailable: boolean;
let taskDelay: Promise<void> | undefined;
let taskRequests: Array<string>;
let overview: FactoryOverview;
let fileRequests: Array<string>;
let fileFailure: boolean;
let emptyFiles: boolean;
let changedPath: string;
const prHead = CommitSha.make("a".repeat(40));
const attemptHead = CommitSha.make("c".repeat(40));
const attemptId = AttemptId.make("attempt-changes");
const changesOf = (head: CommitSha) =>
  FileChanges.make({
    base: CommitSha.make("b".repeat(40)),
    head,
    filesTruncated: head === attemptHead,
    files: emptyFiles
      ? []
      : [
          ChangedFile.make({
            path: changedPath,
            oldPath: "src/old-reader.ts",
            status: "renamed",
            additions: 1,
            deletions: 1,
            patch: {
              kind: "text",
              text:
                head === attemptHead
                  ? "@@ -1 +1 @@\n-before\n+attempt change"
                  : "@@ -1 +1 @@\n-before\n+whole PR change",
              truncated: head === attemptHead,
            },
            test: false,
            generated: false,
          }),
          ChangedFile.make({
            path: "test/reader.test.ts",
            oldPath: null,
            status: "added",
            additions: 1,
            deletions: 0,
            patch: { kind: "text", text: "@@ -0,0 +1 @@\n+test", truncated: false },
            test: true,
            generated: false,
          }),
          ChangedFile.make({
            path: "pnpm-lock.yaml",
            oldPath: null,
            status: "modified",
            additions: 0,
            deletions: 0,
            patch: { kind: "omitted" },
            test: false,
            generated: true,
          }),
        ],
  });
const taskWithChanges = () => {
  const task = fullTask();
  return TaskView.make({
    ...task,
    items: EffectArray.map(task.items, (item) =>
      TaskItemView.make({
        ...item,
        pullRequest:
          item.kind === "pr"
            ? TaskPullRequestState.make({
                base: CommitSha.make("b".repeat(40)),
                head: prHead,
                checks: "SUCCESS",
                review: "APPROVED",
              })
            : null,
      }),
    ),
    attemptChanges: [
      TaskAttemptChangesView.make({
        runId: RunId.make("run-dev"),
        attemptId,
        number: AttemptNumber.make(1),
        loop: LoopName.make("start-dev"),
        pullRequest: ItemNumber.make(42),
        base: CommitSha.make("d".repeat(40)),
        head: attemptHead,
      }),
    ],
  });
};

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

// The operator client uses `globalThis.fetch`, so this fake server answers the page's requests.
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    globalThis.location.href,
  );
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (url.pathname.endsWith("/files")) {
    fileRequests.push(url.toString());
    if (fileFailure)
      return json(
        JSON.stringify({ error: "GitHubApiError", message: "GitHub is unavailable" }),
        502,
      );
    const head = CommitSha.make(url.searchParams.get("head") ?? prHead);
    return json(JSON.stringify(Schema.encodeSync(FileChanges)(changesOf(head))));
  }
  if (url.pathname === "/api/overview")
    return json(JSON.stringify(Schema.encodeSync(FactoryOverview)(overview)));
  if (/^\/api\/projects\/[^/]+$/u.test(url.pathname)) {
    const project = overview.projects[0];
    if (project !== undefined) return json(JSON.stringify(Schema.encodeSync(ProjectView)(project)));
    return json("{}", 404);
  }
  if (url.pathname === "/api/agents") return json('["developer","reviewer"]');
  const runHistory = /\/tasks\/(\d+)\/runs$/u.exec(url.pathname)?.[1];
  if (runHistory !== undefined) {
    const task = tasks.get(runHistory);
    return json(
      JSON.stringify({
        runs: task === undefined ? [] : Schema.encodeSync(TaskView)(task).runs,
        total: task?.runs.length ?? 0,
        nextOffset: null,
      }),
    );
  }
  const number = /\/tasks\/(\d+)$/u.exec(url.pathname)?.[1];
  if (number !== undefined) {
    taskRequests.push(number);
    await taskDelay;
    if (taskUnavailable)
      return json(
        JSON.stringify({ error: "BackendUnavailableError", message: "GitHub is unavailable" }),
        503,
      );
    const task = tasks.get(number);
    return task === undefined
      ? json(
          JSON.stringify({
            error: "BoardItemNotFoundError",
            message: `Item ${taskRepository}#${number} was not found on the Board.`,
          }),
          404,
        )
      : json(JSON.stringify(Schema.encodeSync(TaskView)(task)));
  }
  sent.push({ method, path: url.pathname });
  return json('{"ok":true}');
};

const mount = async (number: number | string, width = 1280, repository = taskRepository) => {
  await page.viewport(width, 900);
  queryClient.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
  router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: [`/projects/${repository}/tasks/${number}`],
    }),
    context: { queryClient },
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  const loaded = router.load();
  flushSync(() =>
    root.render(
      <PermissionsContext.Provider value={administratorPermissions}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </PermissionsContext.Provider>,
    ),
  );
  await loaded;
};

const runsTable = () => page.getByRole("region", { name: /^Runs/u });
const rowOf = (loop: string, nth = 0) =>
  runsTable().getByRole("row").filter({ hasText: loop }).nth(nth);
const menuItems = async () => {
  const menu = page.getByRole("menu");
  await expect.element(menu).toBeVisible();
  return menu
    .getByRole("menuitem")
    .elements()
    .map((item) => item.textContent);
};

beforeEach(() => {
  document.documentElement.classList.add("dark");
  sent = [];
  fileRequests = [];
  fileFailure = false;
  emptyFiles = false;
  changedPath = "src/reader.ts";
  taskUnavailable = false;
  taskDelay = undefined;
  taskRequests = [];
  overview = taskOverview();
  tasks = new Map([
    ["40", fullTask()],
    ["12", quietTask()],
  ]);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(overviewQuery().queryKey, overview);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

it.each(["basaltbytes/usine", "Basaltbytes/Usine"])(
  "names the originating issue in the breadcrumb for secondary repository %s",
  async (repository) => {
    overview = ReadyOverview.make({
      ...taskOverview(),
      projects: taskOverview().projects.map((project) =>
        ProjectView.make({
          ...project,
          repository: RepositoryName.make("basaltbytes/primary"),
          repositories: [
            RepositoryName.make("basaltbytes/primary"),
            RepositoryName.make("Basaltbytes/Usine"),
          ],
        }),
      ),
    });
    queryClient.setQueryData(overviewQuery().queryKey, overview);

    await mount(40, 390, RepositoryName.make(repository));

    await expect
      .element(page.getByRole("navigation", { name: "breadcrumb" }))
      .toMatchTextContent("Issue #40");
    await expect.element(page.getByRole("heading", { level: 1 })).toBeVisible();
  },
);

it("heads the page with the originating issue, its current pull request's state, lane, and labels", async () => {
  await mount(40);
  const heading = page.getByRole("heading", { level: 1 });
  await expect.element(heading).toMatchTextContent("Rework the conversation reader");
  const header = page.elementLocator(heading.element().closest("header") ?? document.body);
  await expect
    .element(heading.getByRole("link", { name: "Issue #40, open", exact: true }))
    .toHaveAttribute("href", `https://github.com/${taskRepository}/issues/40`);
  await expect
    .element(header.getByRole("link", { name: "Pull request #41, merged", exact: true }))
    .toBeVisible();
  await expect
    .element(header.getByRole("link", { name: "Pull request #42, open", exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("In review", { exact: true })).toBeVisible();
  // The lane's own label is not shown, as on the card.
  await expect.element(page.getByText("ui", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Needs attention", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Move pull request #42 to another lane" }).click();
  expect(await menuItems()).toEqual(["Backlog", "Ready"]);
  await page.getByRole("menuitem", { name: "Ready", exact: true }).click();
  await expect
    .poll(() => sent)
    .toContainEqual({
      method: "POST",
      path: `/api/projects/${taskRepository}/items/42/lane`,
    });
});

it("lists every Run newest first, each opening its Run page with why it ended", async () => {
  await mount(40);
  const rows = runsTable().getByRole("row");
  await expect.poll(() => rows.elements().length).toBe(7);
  expect(
    rows
      .elements()
      .slice(1)
      .map((row) => row.querySelector("td")?.textContent),
  ).toEqual(["Waiting", "Running", "Canceled", "Succeeded", "Failed", "Succeeded"]);
  await expect
    .element(rowOf("start-dev").getByRole("link", { name: "start-dev" }))
    .toHaveAttribute("href", "/projects/basaltbytes-usine/runs/run-dev");
  await expect.element(rowOf("start-dev")).toMatchTextContent("Agent failure");
  await expect
    .element(rowOf("start-dev"))
    .toMatchTextContent("The required check lint failed again");
  await expect
    .element(rowOf("start-dev").getByRole("link", { name: "Issue #40, open", exact: true }))
    .toBeInTheDocument();
  await expect.element(rowOf("review-pr")).toMatchTextContent("Approved by PhilDL");
  await expect.element(rowOf("review-pr")).toMatchTextContent("from the UI");
  await expect.element(rowOf("fix-ci", 1)).toMatchTextContent("Run again by PhilDL");
  // Two Attempts of 30 minutes each.
  await expect.element(rowOf("start-dev")).toMatchTextContent("1 h");
  await expect
    .element(rowOf("plan").getByRole("link", { name: "Pull request #41, merged" }))
    .toHaveAttribute("href", `https://github.com/${taskRepository}/pull/41`);
  // A Run on the pull request it opened shows that pull request once, in its own column.
  expect(
    rowOf("fix-ci", 1)
      .getByRole("link", { name: "Pull request #42, open", exact: true })
      .elements(),
  ).toHaveLength(1);
  // The short ID links to the earlier Run, not to the row's own Run page.
  await rowOf("fix-ci", 1).getByRole("link", { name: "run-canc", exact: true }).click();
  await expect
    .poll(() => router.state.location.pathname)
    .toBe("/projects/basaltbytes-usine/runs/run-canceled");
});

it("offers only the actions that apply to each Run, and never a disabled button", async () => {
  await mount(40);
  await expect.element(rowOf("fix-ci").getByRole("button", { name: "Approve" })).toBeVisible();
  await rowOf("fix-ci")
    .getByRole("button", { name: /^Actions for/u })
    .click();
  expect(await menuItems()).toEqual(["Cancel run"]);
  await userEvent.keyboard("{Escape}");

  await expect.element(rowOf("start-dev").getByRole("button", { name: "Retry" })).toBeVisible();
  await rowOf("start-dev")
    .getByRole("button", { name: /^Actions for/u })
    .click();
  expect(await menuItems()).toEqual(["Edit and retry", "Mark resolved"]);
  await userEvent.keyboard("{Escape}");

  await rowOf("plan")
    .getByRole("button", { name: /^Actions for/u })
    .click();
  expect(await menuItems()).toEqual(["Run again", "Edit and run again"]);
  expect(document.querySelectorAll("button:disabled")).toHaveLength(0);
  await page.getByRole("menuitem", { name: "Edit and run again" }).click();
  await expect.element(page.getByRole("form", { name: "Edit and run again" })).toBeVisible();

  await rowOf("fix-ci").getByRole("button", { name: "Approve" }).click();
  await expect
    .poll(() => sent)
    .toContainEqual({ method: "POST", path: "/api/runs/run-approve/approve" });
});

it("lists the pull requests with their state and the comments the Runs posted", async () => {
  await mount(40);
  const pullRequests = page.getByRole("region", { name: /^Pull requests/u });
  await expect
    .element(pullRequests.getByRole("row").nth(0))
    .toMatchTextContent("Plan the reader rework");
  await expect
    .element(
      pullRequests
        .getByRole("row")
        .nth(0)
        .getByRole("img", { name: "Pull request #41, merged", exact: true }),
    )
    .toBeInTheDocument();
  await expect
    .element(pullRequests.getByRole("row").nth(2))
    .toMatchTextContent("Conflicts with base");
  await expect
    .element(
      pullRequests
        .getByRole("row")
        .nth(2)
        .getByRole("img", { name: "Pull request #42, open", exact: true }),
    )
    .toBeInTheDocument();

  const comments = page.getByRole("region", { name: /^Comments and reviews/u });
  const review = comments.getByRole("row").nth(0);
  await expect.element(review).toMatchTextContent("Review");
  await expect
    .element(review.getByRole("img", { name: "Pull request #41, merged", exact: true }))
    .toBeInTheDocument();
  // The item's mark is the row's only icon; the whole row links to the review.
  expect(review.element().querySelectorAll("svg")).toHaveLength(1);
  await expect
    .element(review.getByRole("link", { name: /^Review/u }))
    .toHaveAttribute("href", `https://github.com/${taskRepository}/pull/41#pullrequestreview-7`);
  await expect
    .element(review.getByRole("link", { name: "review-pr" }))
    .toHaveAttribute("href", "/projects/basaltbytes-usine/runs/run-review");
  // A comment's date is GitHub's posted time, or its Attempt's end time when GitHub has none.
  const posted = review.getByTitle(/^Posted 2026-10-04 /u);
  await expect.element(posted).toHaveAttribute("datetime", "2026-10-04T09:05:00.000Z");
  const undated = comments
    .getByRole("row")
    .nth(1)
    .getByTitle(/^Posted during the attempt/u);
  await expect.element(undated).toHaveAttribute("datetime", "2026-10-02T09:20:00.000Z");
});

it("explains how an Item without Runs, pull requests, or comments fills", async () => {
  await mount(12, 390);
  await expect.element(page.getByText("No runs yet")).toBeVisible();
  await expect.element(page.getByText("No pull requests")).toBeVisible();
  await expect.element(page.getByText("No comments or reviews")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Issue #12, open", exact: true }))
    .toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

it("moves to the originating Item's address, and explains an Item off the Board", async () => {
  tasks.set("42", fullTask());
  await mount(42);
  await expect
    .poll(() => router.state.location.pathname)
    .toBe("/projects/basaltbytes-usine/tasks/40");
  await expect.element(page.getByRole("heading", { level: 1 })).toBeVisible();

  flushSync(() => root.render(null));
  await mount(9999);
  await expect.element(page.getByText("Task not found")).toBeVisible();
});

it("shows pending navigation, then renders the loader's task without a second request", async () => {
  let release = () => {};
  taskDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mounted = mount(40);
  try {
    await expect.element(page.getByText("Loading…", { exact: true })).toBeVisible();
    release();
    await mounted;
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Rework the conversation reader");
    expect(taskRequests).toEqual(["40"]);
  } finally {
    release();
    await mounted;
  }
});

it("retries a failed direct link and retains the task during a failed refresh", async () => {
  taskUnavailable = true;
  await mount(40);
  await expect.element(page.getByText("GitHub is unavailable", { exact: true })).toBeVisible();
  taskUnavailable = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Rework the conversation reader");
  taskUnavailable = true;
  await queryClient.invalidateQueries({
    queryKey: taskQuery(taskRepository, ItemNumber.make(40)).queryKey,
  });
  await expect.element(page.getByText("Could not refresh the task")).toBeVisible();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Rework the conversation reader");
  taskUnavailable = false;
  await queryClient.invalidateQueries({
    queryKey: taskQuery(taskRepository, ItemNumber.make(40)).queryKey,
  });
  await expect.element(page.getByText("Could not refresh the task")).not.toBeInTheDocument();
});

it("rejects an invalid task number before requesting it", async () => {
  await mount("not-a-number");
  await expect.element(page.getByText("Task not found", { exact: true })).toBeVisible();
  expect(taskRequests).toEqual([]);
});

it("shows whole-PR and attempt changes in place and reuses the immutable query", async () => {
  tasks.set("40", taskWithChanges());
  await mount(40);
  expect(fileRequests).toHaveLength(0);
  const pullRequests = page.getByRole("region", { name: /^Pull requests/u });
  await pullRequests.getByText("Changes", { exact: true }).nth(1).click();
  const changes = page.getByRole("region", { name: "Changes for pull request #42", exact: true });
  await expect.element(changes.getByText("Checks: passed")).toBeVisible();
  await expect.element(changes.getByText("Review: approved")).toBeVisible();
  await expect.element(changes.getByText("src/reader.ts", { exact: true })).toBeVisible();
  await expect
    .element(changes.getByText("whole PR change", { exact: false }))
    .not.toBeInTheDocument();
  await changes.getByRole("button", { name: /src\/reader.ts/u }).click();
  await expect.element(changes.getByText("whole PR change", { exact: false })).toBeVisible();
  const changesRow = changes.element().closest("tr");
  expect(changesRow).not.toBeNull();
  if (changesRow !== null) {
    expect(getComputedStyle(changesRow).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  }
  expect(fileRequests).toHaveLength(1);
  await changes.getByRole("combobox", { name: "Compare" }).selectOptions(attemptId);
  await expect.element(changes.getByText("Checks: passed")).not.toBeInTheDocument();
  await expect.element(changes.getByText("Review: approved")).not.toBeInTheDocument();
  await expect
    .element(changes.getByText("GitHub limited this file list.", { exact: false }))
    .toBeVisible();
  await changes.getByRole("button", { name: /src\/reader.ts/u }).click();
  await expect.element(changes.getByText("attempt change", { exact: false })).toBeVisible();
  expect(fileRequests).toHaveLength(2);
  expect(fileRequests[1]).toContain("scope=CommitRangeFiles");
  await changes.getByRole("combobox", { name: "Compare" }).selectOptions("whole");
  await expect.element(changes.getByText("Checks: passed")).toBeVisible();
  await expect.element(changes.getByText("Review: approved")).toBeVisible();
  await expect.element(changes.getByText("src/reader.ts", { exact: true })).toBeVisible();
  expect(fileRequests).toHaveLength(2);
  await pullRequests.getByText("Changes", { exact: true }).nth(1).click();
  await pullRequests.getByText("Changes", { exact: true }).nth(1).click();
  await expect.element(changes.getByText("src/reader.ts", { exact: true })).toBeVisible();
  expect(fileRequests).toHaveLength(2);
  const retargeted = TaskView.make({
    ...taskWithChanges(),
    items: EffectArray.map(taskWithChanges().items, (item) =>
      TaskItemView.make({
        ...item,
        pullRequest:
          item.pullRequest === null
            ? null
            : TaskPullRequestState.make({
                ...item.pullRequest,
                base: CommitSha.make("f".repeat(40)),
              }),
      }),
    ),
  });
  tasks.set("40", retargeted);
  queryClient.setQueryData(taskQuery(taskRepository, ItemNumber.make(40)).queryKey, retargeted);
  await expect.poll(() => fileRequests.length).toBe(3);
  expect(fileRequests[2]).toContain("base=" + "f".repeat(40));
  expect(fileRequests[2]).toContain("head=" + prHead);
  const changed = TaskView.make({
    ...taskWithChanges(),
    items: EffectArray.map(taskWithChanges().items, (item) =>
      TaskItemView.make({
        ...item,
        pullRequest:
          item.pullRequest === null
            ? null
            : TaskPullRequestState.make({
                ...item.pullRequest,
                head: CommitSha.make("e".repeat(40)),
              }),
      }),
    ),
  });
  tasks.set("40", changed);
  queryClient.setQueryData(taskQuery(taskRepository, ItemNumber.make(40)).queryKey, changed);
  await expect.poll(() => fileRequests.length).toBe(4);
  expect(fileRequests[3]).toContain("head=" + "e".repeat(40));
});

it("shows file marks and patch availability on a phone without widening the task page", async () => {
  changedPath = "src/transcript/reader/really-long-directory/reader-with-a-long-filename.ts";
  tasks.set("40", TaskView.make({ ...taskWithChanges(), attemptChanges: [] }));
  await mount(40, 390);
  await page
    .getByRole("region", { name: /^Pull requests/u })
    .getByText("Changes", { exact: true })
    .nth(1)
    .click();
  const changes = page.getByRole("region", { name: "Changes for pull request #42", exact: true });
  const path = changes.getByText(changedPath, { exact: true });
  await expect.element(path).toBeVisible();
  expect(getComputedStyle(path.element()).whiteSpace).toBe("normal");
  expect(path.element().scrollWidth).toBeLessThanOrEqual(path.element().clientWidth);
  await expect.element(changes.getByRole("combobox", { name: "Compare" })).not.toBeInTheDocument();
  await expect.element(changes.getByText("Whole pull request", { exact: true })).toBeVisible();
  await expect.element(changes.getByText("test", { exact: true })).toBeVisible();
  await expect.element(changes.getByText("generated", { exact: true })).toBeVisible();
  await changes.getByRole("button", { name: /pnpm-lock.yaml/u }).click();
  await expect.element(changes.getByText("No diff available for this file.")).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

it("keeps errors local with retry and shows an empty commit comparison", async () => {
  tasks.set("40", taskWithChanges());
  fileFailure = true;
  await mount(40);
  await page
    .getByRole("region", { name: /^Pull requests/u })
    .getByText("Changes", { exact: true })
    .nth(1)
    .click();
  const changes = page.getByRole("region", { name: "Changes for pull request #42", exact: true });
  await expect.element(changes.getByText("Could not load changes", { exact: true })).toBeVisible();
  fileFailure = false;
  emptyFiles = true;
  await changes.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.element(changes.getByText("No files changed in this comparison")).toBeVisible();
});

it("says when the pull request's attempts pushed no new commits", async () => {
  const task = taskWithChanges();
  tasks.set(
    "40",
    TaskView.make({
      ...task,
      attemptChanges: EffectArray.map(task.attemptChanges, (attempt) =>
        TaskAttemptChangesView.make({ ...attempt, base: attempt.head }),
      ),
    }),
  );
  await mount(40);
  await page
    .getByRole("region", { name: /^Pull requests/u })
    .getByText("Changes", { exact: true })
    .nth(1)
    .click();
  const changes = page.getByRole("region", { name: "Changes for pull request #42", exact: true });
  await expect
    .element(changes.getByText("Attempts on this pull request pushed no new commits"))
    .toBeVisible();
  await expect.element(changes.getByRole("combobox", { name: "Compare" })).not.toBeInTheDocument();
  await expect
    .element(changes.getByText("No attempt commits recorded", { exact: false }))
    .not.toBeInTheDocument();
});
