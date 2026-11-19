import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import {
  administratorPermissions,
  type PermissionGrant,
  PermissionGrant as Grant,
} from "@usine/core/access";
import { StandingGrantId } from "@usine/core/permission-request";
import { FactoryOverview } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { configurationFixture } from "~/lib/configuration/fixture";
import { configurationQuery } from "~/lib/configuration/queries";
import {
  ada,
  answered,
  conversationId,
  conversationOf,
  conversationProject,
  conversationServer,
  type ConversationServer,
  encodedResponse,
  stepEvents,
  supervisorCalls,
} from "~/lib/conversations/fixture";
import {
  loopChangeRequest,
  messageRequest,
  type PermissionServer,
  permissionServer,
  ranOnce,
  retryGrant,
  retryRequest,
} from "~/lib/conversations/request-fixture";
import { overviewQuery } from "~/lib/overview";
import { sessionQuery } from "~/lib/permissions";
import { taskOverview } from "~/lib/tasks/fixture";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let conversations: ConversationServer;
let permissions: PermissionServer;
let answer: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// The operator client keeps the `fetch` it first sees, so this one forwards to each test's server.
globalThis.fetch = (input, init) => answer(input, init);

const viewer: ReadonlyArray<PermissionGrant> = [
  Grant.make({ permission: "read", scope: conversationProject }),
];

const mount = async (path: string, grants: ReadonlyArray<PermissionGrant>) => {
  queryClient.setQueryData(sessionQuery().queryKey, { permissions: grants, member: ada });
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
};

/** A turn that made the requests `requests` with its second call, between two reads. */
const requesting = (requests: ReturnType<typeof retryRequest>[]) => {
  conversations.conversations.set(conversationId, {
    ...conversationOf([
      {
        turn: "t-1",
        member: ada,
        text: "Retry run 7431",
        minute: 1,
        state: answered(1),
        answer: "The retry waits for your answer.",
      },
    ]),
    requests,
  });
  conversations.events.set(
    conversationId,
    stepEvents("t-1", 1, [
      ...supervisorCalls(1),
      { tool: "mcp__usine__retry", input: { runId: "run-7431" } },
      { tool: "mcp__usine__intervene", input: { runId: "run-7431" } },
      ...supervisorCalls(1),
    ]),
  );
};

const request = (name: string) => page.getByRole("group", { name: `Permission request: ${name}` });

beforeEach(async () => {
  document.documentElement.classList.add("dark");
  await page.viewport(1280, 900);
  const fake = conversationServer(async (url) =>
    url.pathname === "/api/overview"
      ? encodedResponse(FactoryOverview, taskOverview())
      : encodedResponse(Schema.Array(Schema.Never), []),
  );
  const supervisor = permissionServer(fake.server, fake.fetch);
  conversations = fake.server;
  permissions = supervisor.server;
  answer = supervisor.fetch;
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

it("answers a request once at its call and shows who allowed it and what it did", async () => {
  requesting([retryRequest(), loopChangeRequest({ answerable: false })]);
  await mount(`/conversations?conversation=${conversationId}`, administratorPermissions);
  const retry = request("Retry a failed run");
  await expect.element(retry).toBeVisible();
  await expect.element(retry.getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect.element(retry.getByRole("button", { name: /^Allow always for / })).toBeVisible();
  await expect.element(retry.getByRole("button", { name: "Deny" })).toBeVisible();
  const loopChange = request("Replace a configuration entity");
  await expect.element(loopChange.getByText(/Answering needs maintain access on /u)).toBeVisible();
  expect(loopChange.getByRole("button", { name: /^Allow|^Deny/u }).elements()).toHaveLength(0);
  await retry.getByRole("button", { name: "Allow once" }).click();
  await expect.element(retry.getByText("Allowed once by ada · Ran")).toBeVisible();
  expect(retry.getByRole("button", { name: "Allow once" }).elements()).toHaveLength(0);
  expect(permissions.answers).toEqual(["r-1 once"]);
});

it("offers only once and deny for an operator message, and no answer to a reader", async () => {
  requesting([messageRequest()]);
  await mount(`/conversations?conversation=${conversationId}`, administratorPermissions);
  const message = request("Send an operator message");
  await expect.element(message.getByRole("button", { name: "Allow once" })).toBeVisible();
  expect(
    message
      .getByRole("button", { name: /^Allow|^Deny/u })
      .elements()
      .map((button) => button.textContent),
  ).toEqual(["Allow once", "Deny"]);
  flushSync(() => root.unmount());
  root = createRoot(host);
  queryClient.clear();
  queryClient.setQueryData(overviewQuery().queryKey, taskOverview());
  requesting([retryRequest({ answerable: false })]);
  await mount(`/conversations?conversation=${conversationId}`, viewer);
  const retry = request("Retry a failed run");
  await expect.element(retry.getByText(/^Waiting for an answer/)).toBeVisible();
  expect(retry.getByRole("button").elements()).toHaveLength(0);
});

it("lists standing grants with revocation, and the calls that ran", async () => {
  permissions.grants.push(
    retryGrant(),
    retryGrant({ id: StandingGrantId.make("g-2"), revocable: false }),
  );
  permissions.actions.push(retryRequest({ state: ranOnce(4), answerable: false }));
  queryClient.setQueryData(configurationQuery().queryKey, configurationFixture());
  await mount("/configuration/grants", administratorPermissions);
  const grants = page.getByRole("table").first();
  await expect.element(grants.getByText("Retry a failed run").first()).toBeVisible();
  expect(grants.getByRole("button", { name: "Revoke" }).elements()).toHaveLength(1);
  await grants.getByRole("button", { name: "Revoke" }).click();
  await grants.getByRole("button", { name: "Confirm revocation" }).click();
  await expect.poll(() => permissions.grants.map(({ id }) => id)).toEqual(["g-2"]);
  await expect
    .element(page.getByRole("table").last().getByText("Allowed once by ada"))
    .toBeVisible();
});
