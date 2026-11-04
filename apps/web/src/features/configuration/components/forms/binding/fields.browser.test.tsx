import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import {
  administratorPermissions,
  GitHubUserId,
  InstanceScope,
  ProjectScope,
  RoleBinding,
} from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { ConfigurationView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { configurationFixture } from "~/lib/configuration/fixture";
import { configurationQuery } from "~/lib/configuration/queries";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    bindingEditorResponses: (configuration: string) => Promise<void>;
  }
}

const button = (name: string) => page.getByRole("button", { name, exact: true });
const select = (name: string) => page.getByRole("combobox", { name, exact: true });
const assertForm = async () => {
  await expect.element(select("Member")).toBeVisible();
  expect(document.querySelector('input[type="number"]')).toBeNull();
  expect([...document.querySelectorAll("label")].map((label) => label.textContent)).not.toContain(
    "_tag",
  );
};

it.each([1440, 390])(
  "creates, edits and deletes bindings by login with attributed revisions at %i pixels",
  async (width) => {
    await page.viewport(width, 900);
    const wasDark = document.documentElement.classList.contains("dark");
    const initial = ConfigurationView.make({
      ...configurationFixture(),
      bindings: [
        RoleBinding.make({
          name: "instance-admin",
          member: GitHubUserId.make(1),
          role: "admin",
          scope: InstanceScope.make(),
        }),
        RoleBinding.make({
          name: "imported-viewer",
          member: GitHubUserId.make(99999),
          role: "viewer",
          scope: ProjectScope.make({ project: ProjectId.make("usine") }),
        }),
      ],
    });
    const configuration = JSON.stringify(Schema.encodeSync(ConfigurationView)(initial));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const router = createRouter({
      routeTree,
      context: { queryClient: client },
      history: createMemoryHistory({ initialEntries: ["/members"] }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const device = width === 390 ? "phone" : "desktop";
    const capture = async (name: string) => {
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      for (const theme of ["dark", "light"]) {
        document.documentElement.classList.toggle("dark", theme === "dark");
        await commands.configurationEditorScreenshot(`810-${name}-${device}-${theme}`);
      }
    };
    try {
      await commands.configurationEditorResponses([], configuration);
      await commands.accessResponses(configuration, JSON.stringify(administratorPermissions));
      await commands.bindingEditorResponses(configuration);
      await router.load();
      flushSync(() =>
        root.render(
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
        ),
      );
      await expect.element(page.getByRole("columnheader", { name: "Bindings" })).toBeVisible();
      await capture("members");
      await page.getByRole("link", { name: "Add binding · olivia-operator", exact: true }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("olivia-project");
      await button("Edit").click();
      await assertForm();
      await expect.element(select("Member")).toHaveValue("2");
      expect([...document.querySelectorAll("select")][0]?.textContent).toContain("olivia-operator");
      await select("Scope").selectOptions("project:usine");
      await select("Role").selectOptions("operator");
      await button("Save").click();
      await expect
        .element(page.getByText("This member was removed. Choose another member.").first())
        .toBeVisible();
      await expect.element(select("Member")).toHaveAttribute("aria-invalid", "true");
      await select("Member").selectOptions("3");
      await select("Member").selectOptions("2");
      await capture("new-binding");
      await button("Edit as text").click();
      const source = page.getByRole("textbox", { name: "Configuration text", exact: true });
      await expect.element(source).toHaveValue(expect.stringContaining("member: 2"));
      await expect.element(source).toHaveValue(expect.stringContaining("_tag: Project"));
      await button("Edit as form").click();
      await expect.element(select("Role")).toHaveValue("operator");
      await button("Save").click();
      await expect.element(button("Revision 2")).toBeVisible();
      await expect
        .poll(() => client.getQueryData(configurationQuery().queryKey)?.bindings)
        .toContainEqual(
          expect.objectContaining({
            name: "olivia-project",
            member: 2,
            role: "operator",
            scope: expect.objectContaining({ project: "usine" }),
          }),
        );
      await router.navigate({ to: "/members" });
      await page.getByRole("link", { name: "operator · usine", exact: true }).click();
      await button("Edit").click();
      await select("Member").selectOptions("3");
      await select("Role").selectOptions("maintainer");
      await capture("project-binding");
      await button("Save").click();
      await expect.element(button("Revision 3")).toBeVisible();
      await button("Edit").click();
      await select("Scope").selectOptions("instance");
      await expect.element(select("Role")).toHaveValue("admin");
      await select("Scope").selectOptions("project:usine");
      await expect.element(select("Role")).toHaveValue("viewer");
      await select("Scope").selectOptions("instance");
      await capture("instance-binding");
      await button("Save").click();
      await expect.element(button("Revision 4")).toBeVisible();
      await expect
        .poll(() => client.getQueryData(configurationQuery().queryKey)?.bindings)
        .toContainEqual(
          expect.objectContaining({
            member: 3,
            role: "admin",
            scope: expect.objectContaining({ _tag: "Instance" }),
          }),
        );
      await button("Delete").click();
      await button("Confirm delete").click();
      await expect.element(button("Revision 5")).toBeVisible();
      const actors = page
        .getByRole("region", { name: "History" })
        .getByText("alice-admin", { exact: true });
      await expect.element(actors.first()).toBeVisible();
      expect(actors.all()).toHaveLength(4);
      await expect
        .poll(() =>
          client.getQueryData(configurationQuery().queryKey)?.bindings.map(({ name }) => name),
        )
        .toEqual(["instance-admin", "imported-viewer"]);
      await router.navigate({
        to: "/configuration/bindings/$binding",
        params: { binding: "imported-viewer" },
      });
      await button("Edit").click();
      await assertForm();
      await expect.element(select("Member")).toHaveValue("99999");
      await expect
        .element(page.getByRole("option", { name: "Member not enrolled", exact: true }))
        .toBeInTheDocument();
    } finally {
      flushSync(() => root.unmount());
      client.clear();
      host.remove();
      document.documentElement.classList.toggle("dark", wasDark);
    }
  },
);

it("starts a binding from Configuration with an explicit member choice", async () => {
  const configuration = JSON.stringify(
    Schema.encodeSync(ConfigurationView)(configurationFixture()),
  );
  await commands.configurationEditorResponses([], configuration);
  await commands.accessResponses(configuration, JSON.stringify(administratorPermissions));
  await commands.bindingEditorResponses(configuration);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: ["/configuration/bindings"] }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await router.load();
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await button("New").click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("new-binding");
    await button("Edit").click();
    await assertForm();
    await expect.element(select("Member")).toHaveValue("");
    await button("Save").click();
    await expect.element(select("Member")).toHaveAttribute("aria-invalid", "true");
    await expect.element(button("Edit as text")).toBeVisible();
  } finally {
    flushSync(() => root.unmount());
    client.clear();
    host.remove();
  }
});
