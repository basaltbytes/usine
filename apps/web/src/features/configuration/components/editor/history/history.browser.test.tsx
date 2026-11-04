import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import {
  administratorPermissions,
  GitHubUserId,
  InstanceScope,
  ProjectScope,
  RoleBinding,
  type PermissionGrant,
} from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { ConfigurationView, ReadyOverview } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { configurationFixture } from "~/lib/configuration/fixture";
import { configurationQuery } from "~/lib/configuration/queries";
import { overviewQuery, attentionQuery } from "~/lib/overview";
import { PermissionsContext, sessionQuery } from "~/lib/permissions";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    configurationHistoryResponses: (json: string) => Promise<void>;
  }
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let wasDark: boolean;
const configuration = ConfigurationView.make({
  ...configurationFixture(),
  bindings: [
    RoleBinding.make({
      name: "instance-admin",
      member: GitHubUserId.make(1),
      role: "admin",
      scope: InstanceScope.make(),
    }),
  ],
});
const configurationJson = JSON.stringify(Schema.encodeSync(ConfigurationView)(configuration));

beforeEach(() => {
  wasDark = document.documentElement.classList.contains("dark");
  host = document.createElement("div");
  host.className = "text-foreground";
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(configurationQuery().queryKey, configuration);
  const overview = ReadyOverview.make({ projects: [], loops: [], needsYou: [] });
  client.setQueryData(overviewQuery().queryKey, overview);
  client.setQueryData(attentionQuery().queryKey, overview);
});

afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  host.remove();
  document.documentElement.classList.toggle("dark", wasDark);
});

const mount = async (
  path: string,
  permissions: readonly PermissionGrant[] = administratorPermissions,
  revisions?: string,
) => {
  await commands.accessResponses(configurationJson, JSON.stringify(permissions));
  await commands.configurationEditorResponses([], configurationJson);
  if (revisions !== undefined) await commands.configurationHistoryResponses(revisions);
  client.setQueryData(sessionQuery().queryKey, { permissions });
  await page.viewport(390, 900);
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  flushSync(() =>
    root.render(
      <PermissionsContext.Provider value={permissions}>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </PermissionsContext.Provider>,
    ),
  );
  await expect.element(page.getByRole("heading", { level: 1 })).toBeVisible();
  return router;
};

const button = (name: string) => page.getByRole("button", { name, exact: true });
const capture = async (name: string) => {
  for (const theme of ["dark", "light"]) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    for (const [width, device] of [
      [1440, "desktop"],
      [390, "phone"],
    ] as const) {
      await page.viewport(width, 900);
      await expect.poll(() => document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await commands.configurationEditorScreenshot(`962-${name}-${device}-${theme}`);
    }
  }
};

it.each([
  ["loops/start-dev", "loop:start-dev"],
  ["agents/developer", "agent:developer"],
  ["workers/local", "worker:local"],
  ["projects/usine", "project:usine"],
  ["repositories/basaltbytes/usine", "repository:basaltbytes/usine"],
  ["labels/ready", "label:ready"],
  ["bindings/instance-admin", "binding:instance-admin"],
  ["settings", "settings:instance"],
])("opens filtered history in one click from %s", async (path, key) => {
  const router = await mount(`/configuration/${path}`);
  const link = page.getByRole("link", { name: `View history for ${key}`, exact: true });
  await expect.element(link).toBeVisible();
  await expect.element(button("Edit")).toBeEnabled();
  await capture(`${path.split("/")[0]}-detail`);
  await button("Edit").click();
  await expect.element(button("Save")).toBeVisible();
  await capture(`${path.split("/")[0]}-form`);
  await button("Cancel").click();
  await link.click();
  const separator = key.indexOf(":");
  expect(router.state.location.pathname).toBe("/configuration/history");
  expect(router.state.location.search).toMatchObject({
    kind: key.slice(0, separator),
    identifier: key.slice(separator + 1),
  });
  await expect
    .element(page.getByRole("combobox", { name: "Entity type", exact: true }))
    .toHaveValue(key.slice(0, separator));
  await expect
    .element(page.getByRole("textbox", { name: "Entity name", exact: true }))
    .toHaveValue(key.slice(separator + 1));
});

it.each([
  "loops",
  "agents",
  "workers",
  "projects",
  "repositories",
  "labels",
  "bindings",
  "history",
])("keeps %s usable across themes and viewport sizes", async (screen) => {
  await mount(`/configuration/${screen}`);
  await capture(screen);
});

it("applies, clears, and restores the URL filter with browser navigation", async () => {
  const router = await mount("/configuration/history?kind=worker&identifier=local");
  await expect.element(button("Revision 2")).toBeVisible();
  await button("Revision 2").click();
  await expect.element(button("Revert")).toBeVisible();
  await capture("history-filtered");
  await page.getByRole("combobox", { name: "Entity type", exact: true }).selectOptions("agent");
  await page.getByRole("textbox", { name: "Entity name", exact: true }).fill("deleted-agent");
  await button("Filter history").click();
  await expect.element(page.getByText("No revisions", { exact: true })).toBeVisible();
  expect(router.state.location.search).toMatchObject({
    kind: "agent",
    identifier: "deleted-agent",
  });
  await page.getByRole("link", { name: "All entities", exact: true }).click();
  await expect.element(button("Revision 2")).toBeVisible();
  expect(router.state.location.search).toEqual({});
  router.history.back();
  await expect
    .element(page.getByRole("textbox", { name: "Entity name", exact: true }))
    .toHaveValue("deleted-agent");
  router.history.back();
  await expect.element(button("Revision 2")).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Entity name", exact: true }))
    .toHaveValue("local");
});

const projectRevision = (entities: "project" | "project-and-worker") =>
  JSON.stringify([
    {
      number: 2,
      actor: "operator",
      time: "2026-11-04T10:00:00.000Z",
      message: "Rename project",
      entities: [
        { kind: "project", identifier: "usine" },
        ...(entities === "project-and-worker" ? [{ kind: "worker", identifier: "local" }] : []),
      ],
      changes: [
        {
          key: { kind: "project", identifier: "usine" },
          before: { id: "usine", name: "Usine", repositories: [], lanes: [] },
          after: { id: "usine", name: "Factory", repositories: [], lanes: [] },
        },
        ...(entities === "project-and-worker"
          ? [
              {
                key: { kind: "worker", identifier: "local" },
                before: { name: "local", kind: "local", max_concurrent_attempts: 1 },
                after: { name: "local", kind: "local", max_concurrent_attempts: 2 },
              },
            ]
          : []),
      ],
    },
  ]);
const maintainer = RoleBinding.make({
  name: "maintainer",
  member: GitHubUserId.make(2),
  role: "maintainer",
  scope: ProjectScope.make({ project: ProjectId.make("usine") }),
}).permissions;

it("allows a project maintainer to revert a single-entity revision from filtered History", async () => {
  await mount(
    "/configuration/history?kind=project&identifier=usine",
    maintainer,
    projectRevision("project"),
  );
  await button("Revision 2").click();
  await button("Revert").click();
  await page.getByRole("textbox", { name: "Message (optional)", exact: true }).fill("Restore name");
  await button("Confirm revert").click();
  await expect.element(page.getByText("Revision reverted", { exact: true })).toBeVisible();
  expect(await commands.configurationEditorRequests()).toEqual([
    expect.objectContaining({
      url: "/api/configuration/revisions/2/revert",
      payload: { expected: 2, message: "Restore name" },
    }),
  ]);
});

it("keeps mixed-entity revision reverts restricted to admins", async () => {
  await mount(
    "/configuration/history?kind=project&identifier=usine",
    maintainer,
    projectRevision("project-and-worker"),
  );
  await button("Revision 2").click();
  await expect.element(page.getByText("+name: Factory", { exact: false })).toBeVisible();
  await expect.element(button("Revert")).not.toBeInTheDocument();
});

it("keeps history reachable for a reader without edit access", async () => {
  const viewer = RoleBinding.make({
    name: "viewer",
    member: GitHubUserId.make(3),
    role: "viewer",
    scope: ProjectScope.make({ project: ProjectId.make("usine") }),
  }).permissions;
  await mount("/configuration/projects/usine", viewer, projectRevision("project"));
  await page.getByRole("link", { name: "View history for project:usine", exact: true }).click();
  await button("Revision 2").click();
  await expect.element(page.getByText("+name: Factory", { exact: false })).toBeVisible();
  await expect.element(button("Revert")).not.toBeInTheDocument();
});
