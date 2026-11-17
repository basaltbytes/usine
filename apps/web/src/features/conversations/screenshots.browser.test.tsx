import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { type PermissionGrant, PermissionGrant as Grant } from "@usine/core/access";
import { Conversation, ConversationId, ConversationTitle } from "@usine/core/conversation";
import { FactoryOverview } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import {
  ada,
  answered,
  conversationId,
  conversationOf,
  conversationProject,
  conversationServer,
  encodedResponse,
  type ConversationServer,
  grace,
  interrupted,
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

declare module "vitest/browser" {
  interface BrowserCommands {
    configurationEditorScreenshot: (name: string) => Promise<void>;
    reducedMotion: (reduce: boolean) => Promise<void>;
  }
}

const operator: ReadonlyArray<PermissionGrant> = [
  Grant.make({ permission: "read", scope: conversationProject }),
  Grant.make({ permission: "operate", scope: conversationProject }),
];
const viewer: ReadonlyArray<PermissionGrant> = [
  Grant.make({ permission: "read", scope: conversationProject }),
];

let answer: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
// The operator client keeps the `fetch` it first sees, so this one forwards to each scene's server.
globalThis.fetch = (input, init) => answer(input, init);

const question = "Why is run 7431 waiting?";
const finished = () =>
  conversationOf([
    {
      turn: "t-1",
      member: ada,
      text: question,
      minute: 1,
      state: answered(1),
      answer: markdownAnswer,
    },
  ]);
const runningTurn = () =>
  conversationOf([
    { turn: "t-1", member: ada, text: question, minute: 1, state: running(1) },
    { turn: "t-2", member: grace, text: "And which loop opened it?", minute: 2, state: queued },
  ]);
const failedTurn = () =>
  conversationOf([
    {
      turn: "t-1",
      member: ada,
      text: question,
      minute: 1,
      state: answered(1),
      answer: "It waits for approval.",
    },
    { turn: "t-2", member: ada, text: "Who can approve it?", minute: 3, state: interrupted(3) },
  ]);

/** Lists three conversations: answered, running, and failed. */
const listed = (server: ConversationServer) => {
  const named = (id: string, title: string, record: ReturnType<typeof conversationOf>) => ({
    ...record,
    conversation: Conversation.make({
      ...record.conversation,
      id: ConversationId.make(id),
      title: ConversationTitle.make(title),
    }),
  });
  server.conversations.set(
    "c-3",
    named("c-3", "Which pull requests wait for review?", failedTurn()),
  );
  server.conversations.set("c-2", named("c-2", "Why did review-pr fail on #812?", runningTurn()));
  server.conversations.set(conversationId, finished());
};

type Scene = {
  readonly name: string;
  readonly path: string;
  readonly permissions?: ReadonlyArray<PermissionGrant>;
  readonly arrange: (server: ConversationServer) => void;
  readonly ready: string;
};

const scenes: ReadonlyArray<Scene> = [
  { name: "list", path: "/conversations", arrange: listed, ready: "3 conversations" },
  {
    name: "empty-list",
    path: "/conversations",
    arrange: () => undefined,
    ready: "No conversations",
  },
  {
    name: "new-conversation",
    path: "/conversations?conversation=new",
    arrange: listed,
    ready: "Recent conversations",
  },
  {
    name: "running-turn",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => {
      server.conversations.set(conversationId, runningTurn());
      server.events.set(conversationId, turnEvents("t-1", 1, false));
    },
    ready: "Queued after the turn before it",
  },
  {
    name: "finished-markdown",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => {
      server.conversations.set(conversationId, finished());
      server.events.set(conversationId, turnEvents("t-1", 1, true));
    },
    ready: "Approve it, or cancel it if the issue is stale.",
  },
  {
    name: "failed-turn",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => server.conversations.set(conversationId, failedTurn()),
    ready: "The orchestrator restarted during the turn",
  },
  {
    name: "setup-required",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => {
      server.status = {
        state: "setup-required",
        reason:
          "Supervisor sessions run in a container, and Podman or Docker isn't installed on the orchestrator host",
      };
      server.conversations.set(conversationId, finished());
    },
    ready: "Supervisor not set up",
  },
  {
    name: "read-only",
    path: `/conversations?conversation=${conversationId}`,
    permissions: viewer,
    arrange: (server) => server.conversations.set(conversationId, finished()),
    ready: "Read only. Posting needs operate access on basaltbytes/usine",
  },
];

const devices = [
  { device: "desktop", width: 1280, height: 900 },
  { device: "phone", width: 390, height: 844 },
] as const;

it.each(devices)(
  "captures the conversation screens on $device",
  async ({ device, width, height }) => {
    await page.viewport(width, height);
    document.documentElement.classList.add("dark");
    await commands.reducedMotion(true);
    try {
      for (const scene of scenes) {
        const fake = conversationServer(async (url) =>
          url.pathname === "/api/overview"
            ? encodedResponse(FactoryOverview, taskOverview())
            : encodedResponse(Schema.Array(Schema.Never), []),
        );
        scene.arrange(fake.server);
        answer = fake.fetch;
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(overviewQuery().queryKey, taskOverview());
        queryClient.setQueryData(sessionQuery().queryKey, {
          permissions: scene.permissions ?? operator,
          member: ada,
        });
        const router = createRouter({
          routeTree,
          history: createMemoryHistory({ initialEntries: [scene.path] }),
          context: { queryClient },
          defaultPendingMs: 0,
          defaultPendingMinMs: 0,
        });
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        const loaded = router.load();
        flushSync(() =>
          root.render(
            <QueryClientProvider client={queryClient}>
              <RouterProvider router={router} />
            </QueryClientProvider>,
          ),
        );
        await loaded;
        await expect.element(page.getByText(scene.ready).first()).toBeVisible();
        await commands.configurationEditorScreenshot(`881-${scene.name}-${device}`);
        flushSync(() => root.unmount());
        host.remove();
        queryClient.clear();
      }
    } finally {
      document.documentElement.classList.remove("dark");
      await commands.reducedMotion(false);
    }
  },
);
