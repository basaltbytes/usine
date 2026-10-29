import { ContainerLimits } from "@usine/core/worker";
import { Schema } from "effect";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { ConfigurationView, ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { entityKey } from "~/features/configuration/lib/entities";
import { entityQuery } from "~/features/configuration/queries";
import { configurationFixture, configurationJson } from "~/lib/configuration/fixture";
import { configurationQuery } from "~/lib/configuration/queries";
import { overviewQuery } from "~/lib/overview";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    delayConfigurationLookup: (identifier: string) => Promise<void>;
    releaseConfigurationLookup: (identifier: string) => Promise<void>;
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
const editText = async () => {
  await button("Edit").click();
  if (
    [...document.querySelectorAll("button")].some((button) => button.textContent === "Edit as text")
  )
    await button("Edit as text").click();
};

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
  await editText();
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
  await editText();
  const source = page.getByRole("textbox", { name: "Configuration text" });
  await source.fill("my unsaved draft");
  await button("Save").click();
  await expect.element(button("Reload text")).toBeVisible();
  await expect.element(source).toHaveValue("my unsaved draft");
  await expect
    .element(page.getByText("+max_concurrent_attempts: 4", { exact: false }))
    .toBeVisible();
  await button("Reload text").click();
  await button("Edit as text").click();
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
  await editText();
  await expect
    .element(page.getByText("This name already exists. Open the entity to edit it."))
    .toBeVisible();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("new-worker");
  await button("Edit").click();
  await button("Edit as text").click();
  await expect
    .element(page.getByRole("textbox", { name: "Configuration text" }))
    .toHaveValue("name: new-worker\nkind: local\nmax_concurrent_attempts: 1\n");
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
});

it.each([
  ["/configuration/loops/start-dev", "loop", "start-dev"],
  ["/configuration/agents/developer", "agent", "developer"],
  ["/configuration/repositories/BasaltBytes/Usine", "repository", "basaltbytes%2Fusine"],
  ["/configuration/settings", "settings", "instance"],
  ["/configuration/labels/ready", "label", "ready"],
])("edits the stored entity at %s", async (path, kind, identifier) => {
  await mount(path);
  await editText();
  await page.getByRole("textbox", { name: "Configuration text" }).fill("changed text");
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
  expect((await commands.configurationEditorRequests())[0]).toMatchObject({
    method: "PUT",
    url: `/api/configuration/entities/${kind}/${identifier}`,
    payload: { expected: 2, text: "changed text" },
  });
});

it("keeps a loop draft when a refresh removes the loop", async () => {
  await mount("/configuration/loops/start-dev");
  await editText();
  const source = page.getByRole("textbox", { name: "Configuration text" });
  await source.fill("keep this loop draft");
  client.setQueryData(
    configurationQuery().queryKey,
    new ConfigurationView({ ...configurationFixture(), loops: [] }),
  );
  await expect
    .element(page.getByText("loops/start-dev.md", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(source).toHaveValue("keep this loop draft");
  await button("Cancel").click();
  await expect.element(page.getByText("Loop not found", { exact: true })).toBeVisible();
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
  await editText();
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
  await editText();
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

it.each(["alpha", "developer"])(
  "discards a canceled lookup for %s while another creation is pending",
  async (identifier) => {
    await mount("/configuration/agents");
    await commands.delayConfigurationLookup(identifier);
    await commands.delayConfigurationLookup("beta");
    await button("New").click();
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await name.fill(identifier);
    await editText();
    await expect.element(name).toBeDisabled();
    await button("Cancel").click();
    await button("New").click();
    await expect.element(name).toHaveValue("");
    await name.fill("beta");
    await editText();
    await commands.releaseConfigurationLookup(identifier);
    await expect
      .poll(
        () =>
          client.getQueryState(entityQuery(entityKey("agent", identifier)).queryKey)?.fetchStatus,
      )
      .toBe("idle");
    await expect.element(name).toHaveValue("beta");
    await expect.element(name).toBeDisabled();
    await expect.element(button("Loading…")).toBeDisabled();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await commands.releaseConfigurationLookup("beta");
    await expect.element(page.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
    await button("Save").click();
    await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
    expect((await commands.configurationEditorRequests())[0]).toMatchObject({
      method: "PUT",
      url: "/api/configuration/entities/agent/beta",
    });
  },
);

it.each([
  {
    kind: "agent",
    identifier: "developer",
    path: "/configuration/agents/developer",
    label: "Model",
    role: "combobox",
    before: "gpt-6.1-sol",
    after: "custom/new-model",
    field: ["model"],
  },
  {
    kind: "worker",
    identifier: "local",
    path: "/configuration/workers/local",
    label: "Concurrent attempts",
    role: "spinbutton",
    before: 2,
    after: "3",
    field: ["max_concurrent_attempts"],
  },
  {
    kind: "settings",
    identifier: "instance",
    path: "/configuration/settings",
    label: "Poll interval (seconds)",
    role: "spinbutton",
    before: 60,
    after: "90",
    field: ["settings", "poll_interval"],
  },
  {
    kind: "repository",
    identifier: "basaltbytes/usine",
    path: "/configuration/repositories/basaltbytes/usine",
    label: "Tags (comma-separated)",
    role: "textbox",
    before: "",
    after: "frontend, production",
    field: ["tags"],
  },
] as const)(
  "loads, changes, round-trips text, shows field refusals, and saves the $kind form",
  async (scenario) => {
    await mount(scenario.path, [
      {
        status: 422,
        body: JSON.stringify({
          error: "ConfigurationInvalid",
          message: "The configuration is invalid.",
          problems: [
            {
              entity: { kind: scenario.kind, identifier: scenario.identifier },
              path: scenario.field,
              message: "This value was refused by the server",
            },
          ],
        }),
      },
    ]);
    await button("Edit").click();
    const field = page.getByRole(scenario.role, { name: scenario.label, exact: true });
    await expect.element(field).toHaveValue(scenario.before);
    await field.fill(scenario.after);
    await button("Edit as text").click();
    await expect.element(page.getByRole("textbox", { name: "Configuration text" })).toBeVisible();
    await button("Edit as form").click();
    await expect
      .element(field)
      .toHaveValue(scenario.role === "spinbutton" ? Number(scenario.after) : scenario.after);
    await button("Save").click();
    await expect.element(field).toHaveAttribute("aria-invalid", "true");
    const help = field.element().getAttribute("aria-describedby");
    expect(help === null ? "" : document.getElementById(help)?.textContent).toContain(
      "This value was refused by the server",
    );
    for (const width of [390, 1440]) {
      await page.viewport(width, 900);
      await expect.poll(() => document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await commands.configurationEditorScreenshot(`${scenario.kind}-form-${width}`);
    }
    await page.getByRole("textbox", { name: "Message (optional)" }).fill("Update configuration");
    await button("Save").click();
    await expect.element(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    const requests = await commands.configurationEditorRequests();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      method: "PUT",
      payload: {
        expected: 2,
        message: "Update configuration",
        value:
          scenario.kind === "settings"
            ? { settings: { poll_interval: 90 } }
            : scenario.kind === "worker"
              ? { max_concurrent_attempts: 3 }
              : scenario.kind === "agent"
                ? { model: scenario.after }
                : { tags: ["frontend", "production"] },
      },
    });
  },
);

it("blocks invalid worker values locally and keeps invalid text when returning to the form", async () => {
  await mount();
  await button("Edit").click();
  const slots = page.getByRole("spinbutton", { name: "Concurrent attempts" });
  await slots.fill("-1");
  await button("Save").click();
  await expect.element(slots).toHaveAttribute("aria-invalid", "true");
  expect(await commands.configurationEditorRequests()).toHaveLength(0);
  await button("Edit as text").click();
  const source = page.getByRole("textbox", { name: "Configuration text" });
  await source.fill("name: local\nkind: unknown\n");
  await button("Edit as form").click();
  await expect.element(source).toHaveValue("name: local\nkind: unknown\n");
  await source.fill("name: local\nkind: local\nmax_concurrent_attempts: 5\n");
  await button("Edit as form").click();
  await expect.element(slots).toHaveValue(5);
});

it("keeps a form draft across a revision conflict and reloads the current values", async () => {
  await mount(undefined, [
    {
      status: 409,
      body: JSON.stringify({ error: "StaleRevision", message: "Changed", expected: 2, current: 3 }),
    },
  ]);
  await button("Edit").click();
  const slots = page.getByRole("spinbutton", { name: "Concurrent attempts" });
  await slots.fill("3");
  await button("Save").click();
  await expect.element(button("Save")).toBeDisabled();
  await expect.element(slots).toHaveValue(3);
  await button("Reload text").click();
  await expect.element(slots).toHaveValue(4);
  await expect
    .element(page.getByRole("textbox", { name: "Unsaved draft" }))
    .toHaveValue("name: local\nkind: local\nmax_concurrent_attempts: 3\n");
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(2);
  expect((await commands.configurationEditorRequests())[1]?.payload).toMatchObject({
    expected: 3,
    value: { max_concurrent_attempts: 4 },
  });
});

it("offers only unregistered installation repositories when creating a repository", async () => {
  await mount("/configuration/repositories");
  await button("New").click();
  const picker = page.getByRole("combobox", { name: "Repository", exact: true });
  await expect.element(picker).toBeEnabled();
  await expect
    .element(page.getByRole("option", { name: "basaltbytes/usine", exact: true }))
    .not.toBeInTheDocument();
  await picker.selectOptions("basaltbytes/new-project");
  await button("Edit").click();
  await expect
    .element(page.getByRole("textbox", { name: "Repository", exact: true }))
    .toHaveValue("basaltbytes/new-project");
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
  expect((await commands.configurationEditorRequests())[0]).toMatchObject({
    url: "/api/configuration/entities/repository/basaltbytes%2Fnew-project",
    payload: { value: { name: "basaltbytes/new-project" } },
  });
});

it("uses supported harnesses, accepts a custom model, and previews the edited Markdown persona", async () => {
  await mount("/configuration/agents/developer");
  await button("Edit").click();
  await page.getByRole("combobox", { name: "Harness", exact: true }).selectOptions("claude");
  await page.getByRole("combobox", { name: "Effort", exact: true }).selectOptions("high");
  await page.getByRole("combobox", { name: "Model", exact: true }).fill("new-provider-model");
  await page
    .getByRole("textbox", { name: "Persona", exact: true })
    .fill("## Review changes\n\nRun the checks.");
  await button("Preview persona").click();
  await expect.element(page.getByRole("heading", { name: "Review changes" })).toBeVisible();
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
  expect((await commands.configurationEditorRequests())[0]?.payload).toMatchObject({
    value: {
      harness: "claude",
      model: "new-provider-model",
      persona: "## Review changes\n\nRun the checks.",
    },
  });
});

it("reorders lanes by keyboard and pointer, then saves renamed lanes and live label choices", async () => {
  await mount("/configuration/repositories/basaltbytes/usine");
  await page.viewport(1440, 1100);
  await button("Edit").click();
  const names = page.getByRole("textbox", { name: "Lane name", exact: true });
  await expect.element(names.nth(0)).toHaveValue("Ready");
  button("Reorder lane 1").element().focus();
  await userEvent.keyboard(" ");
  await expect.element(button("Reorder lane 1")).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .poll(() => document.querySelector("[id^=DndLiveRegion]")?.textContent)
    .toContain("over droppable area 1");
  await userEvent.keyboard(" ");
  await expect.element(names.nth(0)).toHaveValue("Review");
  await button("Reorder lane 1").dropTo(button("Reorder lane 2"), { steps: 10 });
  await expect.element(names.nth(0)).toHaveValue("Ready");
  await names.nth(0).fill("Queued");
  await button("Remove lane").nth(1).click();
  await button("Add lane").click();
  await names.nth(1).fill("In review");
  await page.getByRole("checkbox", { name: "review", exact: true }).nth(1).click();
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
  expect((await commands.configurationEditorRequests())[0]?.payload).toMatchObject({
    value: {
      lanes: [
        { name: "Queued", sources: [{ label: "ready" }] },
        { name: "In review", sources: [{ label: "review" }] },
      ],
    },
  });
});

it("shows derived container limits and validates environment variable names in an SSH worker form", async () => {
  await mount();
  client.setQueryData(
    configurationQuery().queryKey,
    new ConfigurationView({
      ...configurationFixture(),
      workers: configurationFixture().workers.map((worker) =>
        worker.name === "local"
          ? {
              ...worker,
              containerLimits: Schema.decodeUnknownSync(ContainerLimits)({
                cpus: 2,
                memoryMib: 2048,
                pids: 256,
              }),
            }
          : worker,
      ),
    }),
  );
  await button("Edit").click();
  await page.getByRole("combobox", { name: "Worker kind" }).selectOptions("ssh");
  await page.getByRole("textbox", { name: "Working directory" }).fill("/work");
  await page.getByRole("textbox", { name: "SSH destination", exact: true }).fill("host");
  await expect
    .element(
      page.getByText("Last preflight: 2048. Derived at preflight when unset.", { exact: true }),
    )
    .toBeVisible();
  await page.getByRole("checkbox", { name: "Gateway", exact: true }).click();
  await page.getByRole("textbox", { name: "Gateway domain" }).fill("gateway.test");
  await page.getByRole("textbox", { name: "Gateway SSH destination" }).fill("gateway");
  const secret = page.getByRole("textbox", { name: "Gateway token variable" });
  await secret.fill("secret-value-with-dashes");
  await button("Save").click();
  await expect.element(secret).toHaveAttribute("aria-invalid", "true");
  expect(await commands.configurationEditorRequests()).toHaveLength(0);
  await secret.fill("GATEWAY_TOKEN");
  await expect
    .element(
      page.getByText("Enter an environment variable name. The value lives in .env.", {
        exact: true,
      }),
    )
    .toBeVisible();
  await button("Edit as text").click();
  await expect
    .element(page.getByRole("textbox", { name: "Configuration text" }))
    .toHaveValue(expect.stringContaining("admin_token_env: GATEWAY_TOKEN"));
  await button("Edit as form").click();
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
  expect((await commands.configurationEditorRequests())[0]?.payload).toMatchObject({
    value: {
      kind: "ssh",
      destination: "host",
      root: "/work",
      gateway: { admin_token_env: "GATEWAY_TOKEN" },
    },
  });
});

it.each([
  {
    kind: "hetzner",
    source:
      'name: local\nkind: ssh\nroot: /work\nprovisioner:\n  provider: hetzner\n  token_env: HCLOUD_TOKEN\n  server_type: cx33\n  location: nbg1\n  image: "123"\n  ssh_key: usine\n',
    label: "Provider token variable",
    next: "NEW_HCLOUD_TOKEN",
    expected: { provisioner: { provider: "hetzner", token_env: "NEW_HCLOUD_TOKEN", image: "123" } },
  },
  {
    kind: "boat",
    source:
      "name: local\nkind: ssh\nroot: /work\nidentity_file: /keys/id_ed25519\nprovisioner:\n  provider: boat\n  token_env: BOAT_TOKEN\n",
    label: "Provider token variable",
    next: "NEW_BOAT_TOKEN",
    expected: { provisioner: { provider: "boat", token_env: "NEW_BOAT_TOKEN" } },
  },
  {
    kind: "cloudflare",
    source:
      "name: local\nkind: cloudflare\nworker_url: https://worker.example.com\naccess_client_id_env: ACCESS_ID\naccess_client_secret_env: ACCESS_SECRET\nimage: usine\nllm_providers:\n  - provider: openai\n    api_key_env: OPENAI_KEY\n",
    label: "OpenAI API key variable",
    next: "NEW_OPENAI_KEY",
    expected: {
      kind: "cloudflare",
      llm_providers: [{ provider: "openai", api_key_env: "NEW_OPENAI_KEY" }],
    },
  },
])("edits $kind worker fields without dropping provider configuration", async (scenario) => {
  await mount();
  await editText();
  await page.getByRole("textbox", { name: "Configuration text" }).fill(scenario.source);
  await button("Edit as form").click();
  await page.getByRole("textbox", { name: scenario.label, exact: true }).fill(scenario.next);
  await expect.poll(() => document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  await button("Save").click();
  await expect.poll(async () => (await commands.configurationEditorRequests()).length).toBe(1);
  expect((await commands.configurationEditorRequests())[0]?.payload).toMatchObject({
    value: scenario.expected,
  });
});
