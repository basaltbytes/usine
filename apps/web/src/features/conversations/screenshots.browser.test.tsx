import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import {
  administratorPermissions,
  type PermissionGrant,
  PermissionGrant as Grant,
} from "@usine/core/access";
import { Conversation, ConversationId, ConversationTitle } from "@usine/core/conversation";
import { OperationName, StandingGrantId } from "@usine/core/permission-request";
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
  stepEvents,
  supervisorCalls,
} from "~/lib/conversations/fixture";
import { configurationFixture } from "~/lib/configuration/fixture";
import { configurationQuery } from "~/lib/configuration/queries";
import {
  deniedBy,
  failedUnderGrant,
  type PermissionServer,
  permissionServer,
  ranOnce,
  retryGrant,
  retryRequest,
  upgradeRequest,
  withFollowUp,
} from "~/lib/conversations/request-fixture";
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

const failedCall = {
  tool: "mcp__usine__run",
  input: { run: "run-9999" },
  outcome: "failed",
} as const;
const gateText = "Run 7431 waits on the start-dev gate. Reading the loop's approval rule.";
/** A turn of 47 calls, as the owner reported in #1313, with one failure. */
const finishedEvents = () =>
  stepEvents("t-1", 1, [
    "Checking the overview for run 7431.",
    ...supervisorCalls(27),
    failedCall,
    gateText,
    ...supervisorCalls(19),
  ]);
const runningEvents = () =>
  stepEvents("t-1", 1, [
    "Checking the overview for run 7431.",
    ...supervisorCalls(11),
    failedCall,
    gateText,
    ...supervisorCalls(4),
    { tool: "Read", input: { file_path: "packages/config/src/loop.ts" }, outcome: "running" },
  ]);

/** Lists three conversations: failed and running ones unread, and an answered one read. */
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
  server.reads.set(conversationId, 2);
};

type Scene = {
  readonly name: string;
  readonly path: string;
  readonly permissions?: ReadonlyArray<PermissionGrant>;
  readonly arrange: (server: ConversationServer, supervisor: PermissionServer) => void;
  readonly ready: string;
  /** Runs once the scene is ready, before the capture. */
  readonly act?: () => Promise<void>;
};

const scenes: ReadonlyArray<Scene> = [
  { name: "inbox", path: "/conversations", arrange: listed, ready: "2 unread" },
  {
    name: "empty-list",
    path: "/conversations",
    arrange: () => undefined,
    ready: "No conversations",
  },
  { name: "panel-inbox", path: "/tokens?conversation=inbox", arrange: listed, ready: "2 unread" },
  {
    name: "panel-thread",
    path: `/tokens?conversation=${conversationId}`,
    arrange: (server) => {
      listed(server);
      server.conversations.set(conversationId, runningTurn());
      server.events.set(conversationId, runningEvents());
    },
    ready: "Queued after the turn before it",
  },
  {
    name: "new-conversation",
    path: "/conversations?conversation=new",
    arrange: listed,
    ready: "Scope",
  },
  {
    name: "running-turn",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => {
      server.conversations.set(conversationId, runningTurn());
      server.events.set(conversationId, runningEvents());
    },
    ready: "Queued after the turn before it",
  },
  {
    name: "finished-markdown",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => {
      listed(server);
      server.events.set(conversationId, finishedEvents());
    },
    ready: "Approve it, or cancel it if the issue is stale.",
  },
  {
    name: "tool-group-open",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => {
      server.conversations.set(conversationId, finished());
      server.events.set(conversationId, finishedEvents());
    },
    ready: "Approve it, or cancel it if the issue is stale.",
    act: async () => {
      const group = page.getByRole("button", { name: /28 tool calls$/u });
      await group.click();
      await expect.element(group).toHaveAttribute("aria-expanded", "true");
    },
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

/** A turn that asked to retry run 7431 and to upgrade the instance, with the retry in `state`. */
const asking = (server: ConversationServer, retry: ReturnType<typeof retryRequest>) => {
  server.conversations.set(conversationId, {
    ...conversationOf([
      {
        turn: "t-1",
        member: ada,
        text: "Run 7431 failed on a flaky test. Retry it, then upgrade when the queue is empty.",
        minute: 1,
        state: answered(1),
        answer: "Both need a member's answer: the retry of run 7431, and the upgrade to 0.42.0.",
      },
    ]),
    requests: [retry, upgradeRequest({ answerable: false })],
  });
  server.events.set(
    conversationId,
    stepEvents("t-1", 1, [
      "Run 7431 failed in `pnpm test` on a timeout in `sessions.test.ts`; the head passed CI before.",
      ...supervisorCalls(3),
      { tool: "mcp__usine__retry", input: { runId: "run-7431" } },
      { tool: "mcp__usine__requestUpgrade", input: { body: { mode: "idle" } } },
    ]),
  );
};

const permissionScenes: ReadonlyArray<Scene> = [
  {
    name: "request-waiting",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => asking(server, retryRequest()),
    ready: "Allow once",
  },
  {
    name: "request-allowed",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => {
      asking(server, retryRequest({ state: ranOnce(5), answerable: false }));
      const record = server.conversations.get(conversationId);
      if (record !== undefined)
        server.conversations.set(
          conversationId,
          withFollowUp(
            record,
            "t-1",
            "- Retry a failed run: run run-7431. Allowed once by ada. Ran.",
            "Run 7431 is retrying. The upgrade still waits for an admin's answer.",
          ),
        );
    },
    ready: "Allowed once by ada · Ran",
  },
  {
    name: "request-denied",
    path: `/conversations?conversation=${conversationId}`,
    arrange: (server) => asking(server, retryRequest({ state: deniedBy(5), answerable: false })),
    ready: "Denied by grace",
  },
  {
    name: "grants",
    path: "/configuration/grants",
    permissions: administratorPermissions,
    arrange: (_server, supervisor) => {
      supervisor.grants.push(
        retryGrant(),
        retryGrant({
          id: StandingGrantId.make("r-9:grant"),
          operation: OperationName.make("moveBoardItem"),
          summary: "Move a repository item",
          member: grace,
          lastUsedAt: null,
          applies: false,
        }),
      );
      supervisor.actions.push(
        retryRequest({
          id: "r-3",
          target: "run run-7502",
          arguments: { runId: "run-7502" },
          state: failedUnderGrant(9),
          answerable: false,
        }),
        retryRequest({ state: ranOnce(4), answerable: false }),
      );
    },
    ready: "Allowed calls",
  },
];

const captures = [
  { prefix: "881", scenes, devices: [{ device: "phone", width: 390, height: 844 }] },
  {
    prefix: "1297",
    scenes: permissionScenes,
    devices: [
      { device: "desktop", width: 1280, height: 900 },
      { device: "phone", width: 390, height: 844 },
    ],
  },
] as const;

it.each(
  captures.flatMap(({ prefix, scenes: captured, devices }) =>
    devices.map((device) => ({ prefix, scenes: captured, ...device })),
  ),
)(
  "captures the $prefix screens on $device",
  async ({ prefix, scenes: captured, device, width, height }) => {
    await page.viewport(width, height);
    document.documentElement.classList.add("dark");
    await commands.reducedMotion(true);
    try {
      for (const scene of captured) {
        const fake = conversationServer(async (url) =>
          url.pathname === "/api/overview"
            ? encodedResponse(FactoryOverview, taskOverview())
            : encodedResponse(Schema.Array(Schema.Never), []),
        );
        const supervisor = permissionServer(fake.server, fake.fetch);
        scene.arrange(fake.server, supervisor.server);
        answer = supervisor.fetch;
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(overviewQuery().queryKey, taskOverview());
        queryClient.setQueryData(configurationQuery().queryKey, configurationFixture());
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
        await expect.element(page.getByText(scene.ready).last()).toBeVisible();
        await scene.act?.();
        await commands.configurationEditorScreenshot(`${prefix}-${scene.name}-${device}`);
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
