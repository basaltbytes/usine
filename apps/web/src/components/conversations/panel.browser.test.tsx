import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { type PermissionGrant, PermissionGrant as Grant } from "@usine/core/access";
import { FactoryOverview } from "@usine/orchestrator/operator";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { invalidateChanges } from "~/lib/changes";
import {
  ada,
  answered,
  conversationId,
  conversationOf,
  conversationProject,
  conversationServer,
  type ConversationServer,
  encodedResponse,
  errorResponse,
  grace,
  markdownAnswer,
  queued,
  running,
  turnEvents,
} from "~/lib/conversations/fixture";
import { overviewQuery } from "~/lib/overview";
import { sessionQuery } from "~/lib/permissions";
import { taskOverview } from "~/lib/tasks/fixture";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let server: ConversationServer;
let answer: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// The operator client keeps the `fetch` it first sees, so this one forwards to each test's server.
globalThis.fetch = (input, init) => answer(input, init);

const operator: ReadonlyArray<PermissionGrant> = [
  Grant.make({ permission: "read", scope: conversationProject }),
  Grant.make({ permission: "operate", scope: conversationProject }),
];
const viewer: ReadonlyArray<PermissionGrant> = [
  Grant.make({ permission: "read", scope: conversationProject }),
];

const mount = async (path: string, permissions = operator) => {
  queryClient.setQueryData(sessionQuery().queryKey, { permissions, member: ada });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  const loaded = router.load();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await loaded;
  return router;
};

const notice = (revision: number) =>
  ChangeNotice.make({
    revision,
    reset: false,
    changes: [{ kind: "conversation", id: conversationId }],
  });

// The sheet is named by its title, the conversation's.
const panel = () => page.getByRole("dialog");
const composer = () => panel().getByRole("textbox", { name: "Message" });

beforeEach(async () => {
  document.documentElement.classList.add("dark");
  await page.viewport(1280, 900);
  const fake = conversationServer(async (url) =>
    url.pathname === "/api/overview"
      ? encodedResponse(FactoryOverview, taskOverview())
      : encodedResponse(Schema.Array(Schema.Never), []),
  );
  server = fake.server;
  answer = fake.fetch;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(overviewQuery().queryKey, taskOverview());
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

it.each(["/tokens", "/conversations"])(
  "opens the conversation from the search parameter on %s, and Escape closes it",
  async (path) => {
    server.conversations.set(
      conversationId,
      conversationOf([
        {
          turn: "t-1",
          member: ada,
          text: "Why is run 7431 waiting?",
          minute: 1,
          state: answered(1),
          answer: "It waits for approval.",
        },
      ]),
    );
    const router = await mount(`${path}?conversation=${conversationId}`);
    await expect.element(panel()).toBeVisible();
    await expect
      .element(panel().getByText("Why is run 7431 waiting?", { exact: true }).first())
      .toBeVisible();
    await expect.element(panel().getByText("It waits for approval.")).toBeVisible();
    await expect.poll(() => panel().element().contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.element(panel()).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(path);
    expect(router.state.location.search).not.toHaveProperty("conversation");
  },
);

it("streams a running turn's text and tool call, then shows the answer once", async () => {
  server.conversations.set(
    conversationId,
    conversationOf([
      { turn: "t-1", member: ada, text: "Why is run 7431 waiting?", minute: 1, state: running(1) },
    ]),
  );
  server.events.set(conversationId, turnEvents("t-1", 1, false));
  await mount(`/conversations?conversation=${conversationId}`);
  await expect.element(panel().getByText("Checking the overview for run 7431.")).toBeVisible();
  await expect.element(panel().getByRole("button", { name: /· Running$/u })).toBeVisible();
  await expect.element(panel().getByText("Running", { exact: true }).first()).toBeVisible();

  server.events.set(conversationId, turnEvents("t-1", 1, true));
  server.conversations.set(
    conversationId,
    conversationOf([
      {
        turn: "t-1",
        member: ada,
        text: "Why is run 7431 waiting?",
        minute: 1,
        state: answered(1),
        answer: markdownAnswer,
      },
    ]),
  );
  server.requests.length = 0;
  await invalidateChanges(queryClient, notice(2));
  await expect.element(panel().getByText("waiting for approval")).toBeVisible();
  await expect.element(panel().getByRole("button", { name: /· Completed$/u })).toBeVisible();
  expect(server.requests).toContain(`GET /api/conversations/${conversationId}/events?after=2`);
  expect(panel().getByText("Running", { exact: true }).elements()).toHaveLength(0);
});

it("shows a message posted during a running turn as queued after it, and cancels it", async () => {
  server.conversations.set(
    conversationId,
    conversationOf([
      { turn: "t-1", member: ada, text: "First question", minute: 1, state: running(1) },
      { turn: "t-2", member: grace, text: "Second question", minute: 2, state: queued },
    ]),
  );
  await mount(`/conversations?conversation=${conversationId}`);
  await expect.element(panel().getByText("Queued after the turn before it")).toBeVisible();
  const cancels = panel().getByRole("button", { name: "Cancel turn" });
  await expect.poll(() => cancels.elements().length).toBe(2);
  await cancels.nth(1).click();
  await expect
    .poll(() => server.requests)
    .toContain(`POST /api/conversations/${conversationId}/turns/t-2/cancel`);
  await expect.element(panel().getByText("Canceled by ada")).toBeVisible();
});

it("shows an image in a supervisor message as a link, so its URL loads only on a click", async () => {
  server.conversations.set(
    conversationId,
    conversationOf([
      {
        turn: "t-1",
        member: ada,
        text: "Show me",
        minute: 1,
        state: answered(1),
        answer: "Here: ![x](https://example.com/p.png?d=secret)",
      },
    ]),
  );
  await mount(`/conversations?conversation=${conversationId}`);
  const link = panel().getByRole("link", { name: "x", exact: true });
  await expect.element(link).toHaveAttribute("href", "https://example.com/p.png?d=secret");
  await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(panel().element().querySelectorAll("img")).toHaveLength(0);
});

it("shows the setup reason and no composer while the supervisor isn't set up", async () => {
  server.status = { state: "setup-required", reason: "Podman or Docker isn't installed" };
  server.conversations.set(
    conversationId,
    conversationOf([
      { turn: "t-1", member: ada, text: "Hello", minute: 1, state: answered(1), answer: "Hi." },
    ]),
  );
  await mount(`/conversations?conversation=${conversationId}`);
  await expect.element(panel().getByText("Supervisor not set up")).toBeVisible();
  await expect.element(panel().getByText("Podman or Docker isn't installed")).toBeVisible();
  expect(composer().elements()).toHaveLength(0);
});

it("lets a member who can read but not operate read the conversation, with no composer or cancel", async () => {
  server.conversations.set(
    conversationId,
    conversationOf([
      { turn: "t-1", member: ada, text: "First question", minute: 1, state: running(1) },
    ]),
  );
  await mount(`/conversations?conversation=${conversationId}`, viewer);
  await expect.element(panel().getByText("First question")).toBeVisible();
  await expect
    .element(panel().getByText("Read only. Posting needs operate access on basaltbytes/usine"))
    .toBeVisible();
  expect(composer().elements()).toHaveLength(0);
  expect(panel().getByRole("button", { name: "Cancel turn" }).elements()).toHaveLength(0);
});

it("shows a posted message at once and rolls it back with the refusal", async () => {
  server.conversations.set(
    conversationId,
    conversationOf([
      {
        turn: "t-1",
        member: ada,
        text: "First question",
        minute: 1,
        state: answered(1),
        answer: "An answer.",
      },
    ]),
  );
  let refuse: () => void = () => undefined;
  server.post = () =>
    new Promise((resolve) => {
      refuse = () =>
        resolve(
          errorResponse(
            "SupervisorNotReady",
            "No supervisor is configured. Set settings.supervisor.",
            409,
          ),
        );
    });
  await mount(`/conversations?conversation=${conversationId}`);
  await composer().fill("Follow-up question");
  await userEvent.keyboard("{Enter}");
  await expect.element(panel().getByText("Follow-up question")).toBeVisible();
  await expect.element(panel().getByText("Not sent", { exact: true })).toBeVisible();
  await expect.element(composer()).toHaveValue("");
  refuse();
  await expect.element(panel().getByText("Message not sent")).toBeVisible();
  await expect
    .element(panel().getByText("No supervisor is configured. Set settings.supervisor."))
    .toBeVisible();
  await expect.element(composer()).toHaveValue("Follow-up question");
  expect(panel().getByText("Not sent", { exact: true }).elements()).toHaveLength(0);
});
