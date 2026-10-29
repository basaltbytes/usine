import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { configurationFixture, configurationJson } from "~/lib/configuration/fixture";
import { configurationQuery } from "~/lib/configuration/queries";
import { overviewQuery } from "~/lib/overview";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    configurationEditorScreenshot: (name: string) => Promise<void>;
    configurationEditorResponses: (
      rejections: readonly { readonly status: number; readonly body: string }[],
      configuration: string,
    ) => Promise<void>;
    configurationEditorRequests: () => Promise<
      readonly { readonly method: string; readonly url: string; readonly payload: unknown }[]
    >;
  }
}
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  host.className = "dark text-foreground";
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(configurationQuery().queryKey, configurationFixture());
  client.setQueryData(
    overviewQuery().queryKey,
    new ReadyOverview({ projects: [], loops: [], needsYou: [] }),
  );
});
afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  host.remove();
});

const mount = async (
  path = "/configuration/workers/local",
  rejections: readonly { readonly status: number; readonly body: string }[] = [],
) => {
  await commands.configurationEditorResponses(rejections, JSON.stringify(configurationJson));
  await page.viewport(390, 844);
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
};
const button = (name: string) => page.getByRole("button", { name, exact: true });

it("shows entity history as export-format diffs, reverts with a message, and loads older revisions", async () => {
  await mount();
  await button("Revision 2").click();
  await expect
    .element(page.getByText("-max_concurrent_attempts: 1", { exact: false }))
    .toBeVisible();
  await expect
    .element(page.getByText("+max_concurrent_attempts: 2", { exact: false }))
    .toBeVisible();
  await button("Revert").click();
  await page.getByRole("textbox", { name: "Message (optional)" }).fill("Restore slots");
  await button("Confirm revert").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
  expect((await commands.configurationEditorRequests())[0]).toMatchObject({
    method: "POST",
    url: "/api/configuration/revisions/2/revert",
    payload: { expected: 2, message: "Restore slots" },
  });
  await button("Older revisions").click();
  await expect.element(button("Revision 1")).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

it("keeps invalid text and lists every field problem under the editor before saving", async () => {
  await mount(undefined, [
    {
      status: 422,
      body: JSON.stringify({
        error: "ConfigurationInvalid",
        message: "The configuration is invalid.",
        problems: [
          {
            entity: { kind: "worker", identifier: "local" },
            path: ["max_concurrent_attempts"],
            message: "Must be positive",
          },
          {
            entity: { kind: "worker", identifier: "local" },
            path: ["kind"],
            message: "Unknown worker kind",
          },
        ],
      }),
    },
  ]);
  await button("Edit").click();
  const source = page.getByRole("textbox", { name: "Configuration text" });
  await source.fill("kind: unknown\nmax_concurrent_attempts: -1\n");
  await button("Save").click();
  await expect
    .element(page.getByText("worker:local.max_concurrent_attempts", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("worker:local.kind", { exact: true })).toBeVisible();
  await expect.element(source).toHaveValue("kind: unknown\nmax_concurrent_attempts: -1\n");
  await source.fill("name: local\nkind: local\nmax_concurrent_attempts: 3\n");
  await button("Save").click();
  await expect.element(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  expect((await commands.configurationEditorRequests())[1]).toMatchObject({
    method: "PUT",
    payload: { expected: 2, text: "name: local\nkind: local\nmax_concurrent_attempts: 3\n" },
  });
});

it("shows the newer revision on conflict and preserves the draft when reloading text", async () => {
  await mount(undefined, [
    {
      status: 409,
      body: JSON.stringify({
        error: "StaleRevision",
        message: "Configuration changed",
        expected: 2,
        current: 3,
      }),
    },
  ]);
  await button("Edit").click();
  const source = page.getByRole("textbox", { name: "Configuration text" });
  await source.fill("my unsaved draft");
  await button("Save").click();
  await expect.element(button("Reload text")).toBeVisible();
  await expect.element(source).toHaveValue("my unsaved draft");
  await expect
    .element(page.getByText("+max_concurrent_attempts: 4", { exact: false }))
    .toBeVisible();
  await button("Reload text").click();
  await expect
    .element(page.getByRole("textbox", { name: "Unsaved draft" }))
    .toHaveValue("my unsaved draft");
  await expect
    .element(source)
    .toHaveValue("name: local\nkind: local\nmax_concurrent_attempts: 4\n");
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(2);
  expect((await commands.configurationEditorRequests())[1]?.payload).toMatchObject({ expected: 3 });
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

it("creates from a template and refuses to replace an existing name through New", async () => {
  await mount("/configuration/workers");
  await button("New").click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("local");
  await button("Edit").click();
  await expect
    .element(page.getByText("This name already exists. Open the entity to edit it."))
    .toBeVisible();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("new-worker");
  await button("Edit").click();
  await expect
    .element(page.getByRole("textbox", { name: "Configuration text" }))
    .toHaveValue('name: "new-worker"\nkind: local\nmax_concurrent_attempts: 1\n');
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
  expect((await commands.configurationEditorRequests())[0]).toMatchObject({
    method: "PUT",
    url: "/api/configuration/entities/worker/new-worker",
    payload: { expected: 2 },
  });
});

it("names the entity and affected projects before deleting, and displays refusals", async () => {
  await mount(undefined, [
    {
      status: 409,
      body: JSON.stringify({
        error: "RestartRequiredError",
        message: "This worker is running attempts. Restart usine up.",
        blocks: ["workers"],
        fields: ["workers.local"],
      }),
    },
  ]);
  await button("Delete").click();
  await expect.element(page.getByRole("heading", { name: "Delete local?" })).toBeVisible();
  await expect
    .element(page.getByText("Referenced by: project basaltbytes/usine", { exact: false }))
    .toBeVisible();
  expect(await commands.configurationEditorRequests()).toHaveLength(0);
  await button("Confirm delete").click();
  await expect
    .element(page.getByText("This worker is running attempts. Restart usine up."))
    .toBeVisible();
  await button("Confirm delete").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(2);
  expect((await commands.configurationEditorRequests())[1]).toMatchObject({
    method: "DELETE",
    payload: { expected: 2 },
  });
});

it("links the changed entities from instance history", async () => {
  await mount("/configuration/history");
  await expect
    .element(page.getByRole("link", { name: "worker:local", exact: true }))
    .toHaveAttribute("href", "/configuration/workers/local");
  await expect.element(page.getByText("Increase worker slots")).toBeVisible();
  await expect.element(button("Reload configuration")).not.toBeInTheDocument();
});

it.each([
  ["/configuration/loops/start-dev", "loop", "start-dev"],
  ["/configuration/agents/developer", "agent", "developer"],
  ["/configuration/repositories/basaltbytes/usine", "repository", "basaltbytes%2Fusine"],
  ["/configuration/settings", "settings", "instance"],
  ["/configuration/labels/ready", "label", "ready"],
])("edits the stored entity at %s", async (path, kind, identifier) => {
  await mount(path);
  await button("Edit").click();
  await page.getByRole("textbox", { name: "Configuration text" }).fill("changed text");
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
  expect((await commands.configurationEditorRequests())[0]).toMatchObject({
    method: "PUT",
    url: `/api/configuration/entities/${kind}/${identifier}`,
    payload: { expected: 2, text: "changed text" },
  });
});

it("reports worker preflight refusals without discarding the draft", async () => {
  await mount(undefined, [
    {
      status: 409,
      body: JSON.stringify({
        error: "ReloadPreflightError",
        message: "Codex needs a login on local.",
        agents: ["developer"],
        workers: ["local"],
        cause: {
          _tag: "WorkerCapabilityError",
          worker: "local",
          capability: "harness-login",
          message: "Codex needs a login",
        },
      }),
    },
  ]);
  await button("Edit").click();
  const source = page.getByRole("textbox", { name: "Configuration text" });
  await source.fill("keep this draft");
  await button("Save").click();
  await expect.element(page.getByText("Codex needs a login on local.")).toBeVisible();
  await expect.element(source).toHaveValue("keep this draft");
});

it("shows that new loops start paused", async () => {
  await mount("/configuration/loops");
  await button("New").click();
  await expect
    .element(page.getByText("New loops start paused. Review the loop before resuming it."))
    .toBeVisible();
});

it("keeps the raw editor within the page at desktop and phone widths", async () => {
  await mount();
  await button("Edit").click();
  await page
    .getByRole("textbox", { name: "Configuration text" })
    .fill(`name: local\nkind: local\nmax_concurrent_attempts: 2\n# ${"Long line ".repeat(40)}`);
  const textarea = page.getByRole("textbox", { name: "Configuration text" }).element();
  textarea.scrollLeft = 0;
  for (const [width, name] of [
    [1440, "desktop"],
    [390, "mobile"],
  ] as const) {
    await page.viewport(width, 900);
    await expect.poll(() => document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await commands.configurationEditorScreenshot(name);
  }
});
