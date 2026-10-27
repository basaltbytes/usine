import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, useRouterState } from "@tanstack/react-router";
import { FactoryOverview, TaskView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { TaskPage } from "../src/task/page.tsx";
import { memoryRouter } from "./memory-router.tsx";
import { fullTask, quietTask, taskOverview, taskRepository } from "./task-fixture.ts";
import "../src/index.css";

interface Sent {
  readonly method: string;
  readonly path: string;
}

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let router: ReturnType<typeof memoryRouter>;
let sent: Array<Sent>;
let tasks: Map<string, TaskView>;

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

// The operator client uses `globalThis.fetch`, so this fake server answers the page's requests.
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    globalThis.location.href,
  );
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (url.pathname === "/api/overview")
    return json(JSON.stringify(Schema.encodeSync(FactoryOverview)(taskOverview())));
  if (url.pathname === "/api/agents") return json('["developer","reviewer"]');
  const number = /\/tasks\/(\d+)$/u.exec(url.pathname)?.[1];
  if (number !== undefined) {
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

const AtAddress = () => {
  const number = useRouterState({ select: ({ location }) => location.pathname.split("/").at(-1) });
  return <TaskPage key={number} repository={taskRepository} number={number ?? ""} />;
};

const mount = async (number: number | string, width = 1280) => {
  await page.viewport(width, 900);
  router = memoryRouter(AtAddress, `/projects/${taskRepository}/tasks/${number}`);
  await router.load();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
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
  sent = [];
  tasks = new Map([
    ["40", fullTask()],
    ["12", quietTask()],
  ]);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["overview"], taskOverview());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

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
    .toHaveAttribute("href", `/projects/${taskRepository}/runs/run-dev`);
  await expect.element(rowOf("start-dev")).toMatchTextContent("Agent failure");
  await expect
    .element(rowOf("start-dev"))
    .toMatchTextContent("The required check lint failed again");
  await expect
    .element(rowOf("start-dev").getByRole("link", { name: "Issue #40, open", exact: true }))
    .toBeInTheDocument();
  await expect.element(rowOf("review-pr")).toMatchTextContent("Approved by PhilDL");
  await expect.element(rowOf("review-pr")).toMatchTextContent("from GitHub");
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
    .toBe(`/projects/${taskRepository}/runs/run-canceled`);
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
    .element(pullRequests.getByRole("row").nth(1))
    .toMatchTextContent("Conflicts with base");
  await expect
    .element(
      pullRequests
        .getByRole("row")
        .nth(1)
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
    .toHaveAttribute("href", `/projects/${taskRepository}/runs/run-review`);
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
    .toBe(`/projects/${taskRepository}/tasks/40`);
  await expect.element(page.getByRole("heading", { level: 1 })).toBeVisible();

  flushSync(() => root.render(null));
  await mount(9999);
  await expect.element(page.getByText("Task not found")).toBeVisible();
});
