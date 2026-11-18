import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { type PermissionGrant, PermissionGrant as Grant } from "@usine/core/access";
import { Conversation, ConversationId, ConversationTitle } from "@usine/core/conversation";
import { FactoryOverview } from "@usine/orchestrator/operator";
import { ChangeNotice, PostedView } from "@usine/orchestrator/operator/http";
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
  stepEvents,
  supervisorCalls,
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

const panel = () => page.getByRole("dialog");
const list = () => page.getByRole("region", { name: "Conversations" });
const messages = () => page.getByLabelText("Messages");
const composer = () => page.getByRole("textbox", { name: "Message" });
// The open sheet makes the page header inert, so the button is read from the DOM.
const inboxButtonName = () =>
  document
    .querySelector('header button[aria-label^="Ask the supervisor"]')
    ?.getAttribute("aria-label");

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

const answeredConversation = () =>
  conversationOf([
    {
      turn: "t-1",
      member: ada,
      text: "Why is run 7431 waiting?",
      minute: 1,
      state: answered(1),
      answer: "It waits for approval.",
    },
  ]);

it.each(["/tokens", "/projects/basaltbytes-usine"])(
  "opens the conversation from the search parameter on %s; Escape goes back to the list, then closes",
  async (path) => {
    server.conversations.set(conversationId, answeredConversation());
    const router = await mount(`${path}?conversation=${conversationId}`);
    await expect.element(panel()).toBeVisible();
    await expect.element(messages().getByText("It waits for approval.")).toBeVisible();
    await expect.poll(() => panel().element().contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => router.state.location.search).toHaveProperty("conversation", "inbox");
    await expect.element(panel()).toBeVisible();
    await expect
      .poll(() => document.activeElement?.getAttribute("data-inbox-row"))
      .toBe(conversationId);
    await userEvent.keyboard("{Escape}");
    await expect.element(panel()).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(path);
    expect(router.state.location.search).not.toHaveProperty("conversation");
  },
);

it("shows the inbox as the conversations page, where Escape goes back to the list", async () => {
  server.conversations.set(conversationId, answeredConversation());
  const router = await mount(`/conversations?conversation=${conversationId}`);
  await expect.element(messages().getByText("It waits for approval.")).toBeVisible();
  await expect.element(list()).toBeVisible();
  expect(list().element().closest("[role=dialog]")).toBeNull();
  await messages().getByText("It waits for approval.").click();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => router.state.location.search).toHaveProperty("conversation", "inbox");
  await expect.element(page.getByText("No conversation open")).toBeVisible();
});

it("marks unread rows and counts them, moves with j and k, and marks a conversation read on open", async () => {
  const read = Conversation.make({
    ...answeredConversation().conversation,
    id: ConversationId.make("c-2"),
    title: ConversationTitle.make("Which loops are paused?"),
  });
  server.conversations.set(conversationId, answeredConversation());
  server.conversations.set("c-2", { ...answeredConversation(), conversation: read });
  server.reads.set("c-2", 2);
  const router = await mount("/tokens?conversation=inbox");
  await expect.poll(inboxButtonName).toBe("Ask the supervisor, 1 unread");
  const rows = list().getByRole("button", { name: /Why is run 7431 waiting\?|Which loops/u });
  await expect.poll(() => rows.elements().length).toBe(2);
  const unreadRow = list().getByRole("button", { name: /^Unread Why is run 7431 waiting\?/u });
  await expect.element(unreadRow).toBeVisible();
  expect(
    list()
      .getByRole("button", { name: /^Unread Which loops/u })
      .elements(),
  ).toHaveLength(0);
  await expect
    .poll(() => document.activeElement?.getAttribute("data-inbox-row"))
    .toBe(conversationId);
  await userEvent.keyboard("j");
  await expect.poll(() => document.activeElement?.getAttribute("data-inbox-row")).toBe("c-2");
  await userEvent.keyboard("k");
  await expect
    .poll(() => document.activeElement?.getAttribute("data-inbox-row"))
    .toBe(conversationId);
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => router.state.location.search)
    .toHaveProperty("conversation", conversationId);
  await expect
    .poll(() => server.requests)
    .toContain(`POST /api/conversations/${conversationId}/read`);
  await expect.poll(inboxButtonName).toBe("Ask the supervisor");
  await expect.element(unreadRow).not.toBeInTheDocument();
  await expect.poll(() => server.reads.get(conversationId)).toBe(2);
});

it("streams a running turn's text and tool call, then shows the answer once", async () => {
  server.conversations.set(
    conversationId,
    conversationOf([
      { turn: "t-1", member: ada, text: "Why is run 7431 waiting?", minute: 1, state: running(1) },
    ]),
  );
  server.events.set(conversationId, turnEvents("t-1", 1, false));
  await mount(`/tokens?conversation=${conversationId}`);
  await expect.element(messages().getByText("Checking the overview for run 7431.")).toBeVisible();
  const group = messages().getByRole("button", { name: /1 tool call$/u });
  await expect.element(group).toHaveAttribute("aria-expanded", "false");
  await expect.element(messages().getByText("Running overview")).toBeVisible();
  await expect.element(messages().getByText("Running", { exact: true }).first()).toBeVisible();

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
  await expect.element(messages().getByText("waiting for approval")).toBeVisible();
  expect(server.requests.filter((request) => request.includes("/events"))).toEqual([
    `GET /api/conversations/${conversationId}/events?after=2`,
  ]);
  expect(messages().getByText("Running", { exact: true }).elements()).toHaveLength(0);
  expect(messages().getByText("Running overview").elements()).toHaveLength(0);
  await group.click();
  await expect.element(group).toHaveAttribute("aria-expanded", "true");
  await expect.element(messages().getByRole("button", { name: /· Completed$/u })).toBeVisible();
});

const runningWithCalls = (calls: Parameters<typeof stepEvents>[2]) => {
  server.conversations.set(
    conversationId,
    conversationOf([
      { turn: "t-1", member: ada, text: "Why is run 7431 waiting?", minute: 1, state: running(1) },
    ]),
  );
  server.events.set(conversationId, stepEvents("t-1", 1, calls));
};
const stopButton = () => panel().getByRole("button", { name: "Stop", exact: true });
const sendButton = () => panel().getByRole("button", { name: "Send", exact: true });
const toolRows = () => messages().getByRole("button", { name: /· (?:Completed|Error|Running)$/u });

it("stops the running turn from the composer's button while the message box is empty", async () => {
  runningWithCalls(supervisorCalls(3));
  let release: () => void = () => undefined;
  const reply = answer;
  answer = (input, init) =>
    String(input instanceof Request ? input.url : input).endsWith("/turns/t-1/cancel")
      ? new Promise((resolve) => {
          release = () => resolve(reply(input, init));
        })
      : reply(input, init);
  await mount(`/tokens?conversation=${conversationId}`);
  await expect.element(stopButton()).toBeEnabled();
  expect(sendButton().elements()).toHaveLength(0);
  expect(
    messages()
      .getByRole("button", { name: /Cancel/u })
      .elements(),
  ).toHaveLength(0);
  await stopButton().click();
  await expect.element(panel().getByRole("button", { name: "Stopping…" })).toBeDisabled();
  release();
  await expect
    .poll(() => server.requests)
    .toContain(`POST /api/conversations/${conversationId}/turns/t-1/cancel`);
  await expect.element(messages().getByText("Canceled by ada")).toBeVisible();
  // With no turn running, the button sends again.
  await expect.element(sendButton()).toBeDisabled();
  expect(stopButton().elements()).toHaveLength(0);
});

it("stops from the keyboard, keeps focus in the message box, and shows a refusal above it", async () => {
  runningWithCalls(supervisorCalls(1));
  const reply = answer;
  answer = (input, init) =>
    String(input instanceof Request ? input.url : input).endsWith("/turns/t-1/cancel")
      ? Promise.resolve(errorResponse("TurnNotFound", "Turn t-1 already ended.", 404))
      : reply(input, init);
  await mount(`/tokens?conversation=${conversationId}`);
  await expect.element(stopButton()).toBeEnabled();
  await composer().click();
  await userEvent.tab();
  await expect.element(stopButton()).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(panel().getByText("Turn t-1 already ended.")).toBeVisible();
  await expect.element(composer()).toHaveFocus();
  await expect.element(stopButton()).toBeEnabled();
});

it("sends a message typed during a running turn, which queues after it, and keeps the turn running", async () => {
  runningWithCalls(supervisorCalls(2));
  server.post = async () => {
    const record = conversationOf([
      { turn: "t-1", member: ada, text: "Why is run 7431 waiting?", minute: 1, state: running(1) },
      { turn: "t-2", member: ada, text: "Which loop opened it?", minute: 2, state: queued },
    ]);
    server.conversations.set(conversationId, record);
    const [, message] = record.messages;
    const [, turn] = record.turns;
    return message?.role === "member" && turn !== undefined
      ? encodedResponse(PostedView, { message, turn })
      : errorResponse("ConversationNotFound", "Not found", 404);
  };
  await mount(`/tokens?conversation=${conversationId}`);
  await expect.element(stopButton()).toBeVisible();
  await expect
    .element(composer())
    .toHaveAttribute("placeholder", "Ask a follow-up, queued after the running turn");
  await composer().fill("Which loop opened it?");
  await expect.element(sendButton()).toBeEnabled();
  expect(stopButton().elements()).toHaveLength(0);
  await sendButton().click();
  await expect
    .poll(() => server.requests)
    .toContain(`POST /api/conversations/${conversationId}/messages`);
  await expect.element(messages().getByText("Queued after the turn before it")).toBeVisible();
  await expect.element(composer()).toHaveFocus();
  await expect.element(stopButton()).toBeVisible();
  expect(server.requests.filter((request) => request.endsWith("/cancel"))).toEqual([]);
  expect(messages().getByText("Running", { exact: true }).elements()).toHaveLength(1);
});

it("cancels a queued turn from its own row after a confirmation", async () => {
  server.conversations.set(
    conversationId,
    conversationOf([
      { turn: "t-1", member: ada, text: "First question", minute: 1, state: running(1) },
      { turn: "t-2", member: grace, text: "Second question", minute: 2, state: queued },
    ]),
  );
  await mount(`/tokens?conversation=${conversationId}`);
  await expect.element(messages().getByText("Queued after the turn before it")).toBeVisible();
  const cancel = messages().getByRole("button", { name: "Cancel turn" });
  await expect.poll(() => cancel.elements().length).toBe(1);
  await cancel.click();
  const keep = messages().getByRole("button", { name: "Keep queued" });
  await expect.element(keep).toHaveFocus();
  await keep.click();
  expect(messages().getByRole("button", { name: "Confirm cancel" }).elements()).toHaveLength(0);
  await cancel.click();
  expect(server.requests.filter((request) => request.endsWith("/cancel"))).toEqual([]);
  await messages().getByRole("button", { name: "Confirm cancel" }).click();
  await expect
    .poll(() => server.requests)
    .toContain(`POST /api/conversations/${conversationId}/turns/t-2/cancel`);
  await expect.element(messages().getByText("Canceled by ada")).toBeVisible();
  expect(server.requests).not.toContain(
    `POST /api/conversations/${conversationId}/turns/t-1/cancel`,
  );
});

it("folds a finished turn's 40 tool calls into one line that counts the failed one and opens to the calls", async () => {
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
  server.events.set(
    conversationId,
    stepEvents("t-1", 1, [
      "Checking the overview for run 7431.",
      ...supervisorCalls(39),
      { tool: "mcp__usine__run", input: { run: "run-9999" }, outcome: "failed" },
    ]),
  );
  await mount(`/tokens?conversation=${conversationId}`);
  const groups = messages().getByRole("button", { name: /tool calls?$/u });
  await expect.element(groups).toHaveAccessibleName(/, 1 failed · 40 tool calls$/u);
  expect(groups.elements()).toHaveLength(1);
  await expect.element(groups).toHaveAttribute("aria-expanded", "false");
  expect(toolRows().elements()).toHaveLength(0);
  await expect.element(messages().getByText("It waits for approval.")).toBeVisible();
  await groups.click();
  await expect.poll(() => toolRows().elements().length).toBe(40);
  await expect
    .element(messages().getByRole("button", { name: /^run: .* · Error$/u }))
    .toBeVisible();
});

it("shows a running group's current call instead of its rows, outside any announcement", async () => {
  runningWithCalls([
    ...supervisorCalls(12),
    { tool: "Read", input: { file_path: "packages/config/src/loop.ts" }, outcome: "running" },
  ]);
  await mount(`/tokens?conversation=${conversationId}`);
  const group = messages().getByRole("button", { name: /13 tool calls$/u });
  await expect.element(group).toHaveAttribute("aria-expanded", "false");
  const current = messages().getByText("Reading file");
  await expect.element(current).toBeVisible();
  await expect
    .element(messages().getByText("packages/config/src/loop.ts", { exact: true }))
    .toBeVisible();
  expect(current.element().closest("[aria-live]")?.getAttribute("aria-live")).toBe("off");
  expect(toolRows().elements()).toHaveLength(0);
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
  await mount(`/tokens?conversation=${conversationId}`);
  const link = messages().getByRole("link", { name: "x", exact: true });
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
  await mount(`/tokens?conversation=${conversationId}`);
  await expect.element(panel().getByText("Supervisor not set up").last()).toBeVisible();
  await expect.element(panel().getByText("Podman or Docker isn't installed").last()).toBeVisible();
  expect(list().getByRole("button", { name: "New conversation" }).elements()).toHaveLength(0);
  expect(composer().elements()).toHaveLength(0);
});

it("lets a member who can read but not operate read the conversation, with no composer or cancel", async () => {
  server.conversations.set(
    conversationId,
    conversationOf([
      { turn: "t-1", member: ada, text: "First question", minute: 1, state: running(1) },
    ]),
  );
  await mount(`/tokens?conversation=${conversationId}`, viewer);
  await expect.element(messages().getByText("First question")).toBeVisible();
  await expect
    .element(panel().getByText("Read only. Posting needs operate access on basaltbytes/usine"))
    .toBeVisible();
  expect(composer().elements()).toHaveLength(0);
  expect(panel().getByRole("button", { name: "Cancel turn" }).elements()).toHaveLength(0);
  expect(panel().getByRole("button", { name: "Stop" }).elements()).toHaveLength(0);
  expect(list().getByRole("button", { name: "New conversation" }).elements()).toHaveLength(0);
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
  await mount(`/tokens?conversation=${conversationId}`);
  await expect.element(sendButton()).toBeDisabled();
  expect(stopButton().elements()).toHaveLength(0);
  await composer().fill("Follow-up question");
  await userEvent.keyboard("{Enter}");
  await expect.element(messages().getByText("Follow-up question")).toBeVisible();
  await expect.element(messages().getByText("Not sent", { exact: true })).toBeVisible();
  await expect.element(composer()).toHaveValue("");
  refuse();
  await expect.element(panel().getByText("Message not sent")).toBeVisible();
  await expect
    .element(panel().getByText("No supervisor is configured. Set settings.supervisor."))
    .toBeVisible();
  await expect.element(composer()).toHaveValue("Follow-up question");
  expect(messages().getByText("Not sent", { exact: true }).elements()).toHaveLength(0);
});
