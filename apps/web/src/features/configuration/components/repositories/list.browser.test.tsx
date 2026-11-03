import { projectQuery } from "~/features/projects/queries";
import { projectTasksQuery } from "~/features/tasks/queries";
import { administratorPermissions } from "@usine/core/access";
import { PermissionsContext, sessionQuery } from "~/lib/permissions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { ConfigurationView, ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { configurationFixture, configurationJson } from "~/lib/configuration/fixture";
import { configurationQuery } from "~/lib/configuration/queries";
import { overviewQuery, attentionQuery, projectId } from "~/lib/overview";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

it.each([
  { device: "desktop", width: 1440, height: 900, theme: "dark" },
  { device: "desktop", width: 1440, height: 900, theme: "light" },
  { device: "phone", width: 390, height: 844, theme: "dark" },
  { device: "phone", width: 390, height: 844, theme: "light" },
])(
  "opens the installation picker from an empty registry on $device in $theme",
  async ({ device, width, height, theme }) => {
    await page.viewport(width, height);
    await commands.reducedMotion(true);
    document.documentElement.classList.toggle("dark", theme === "dark");
    await commands.configurationEditorResponses(
      [],
      JSON.stringify({ ...configurationJson, repositories: [] }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(
      configurationQuery().queryKey,
      ConfigurationView.make({ ...configurationFixture(), repositories: [] }),
    );
    client.setQueryData(
      overviewQuery().queryKey,
      ReadyOverview.make({ projects: [], loops: [], needsYou: [] }),
    );
    client.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
    const router = createRouter({
      routeTree,
      context: { queryClient: client },
      history: createMemoryHistory({ initialEntries: ["/configuration/repositories"] }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      const cachedOverview = client.getQueryData(overviewQuery().queryKey);
      if (cachedOverview !== undefined)
        client.setQueryData(attentionQuery().queryKey, cachedOverview);
      for (const project of cachedOverview?.projects ?? []) {
        client.setQueryData(projectQuery(projectId(project)).queryKey, project);
        client.setQueryData(projectTasksQuery(projectId(project)).queryKey, project);
      }
      await router.load();
      flushSync(() =>
        root.render(
          <PermissionsContext.Provider value={administratorPermissions}>
            <QueryClientProvider client={client}>
              <RouterProvider router={router} />
            </QueryClientProvider>
          </PermissionsContext.Provider>,
        ),
      );
      await expect
        .element(page.getByText("No repositories registered", { exact: true }))
        .toBeVisible();
      await page.getByRole("button", { name: "New", exact: true }).click();
      const picker = page.getByRole("combobox", { name: "Repository", exact: true });
      await expect.element(picker).toBeEnabled();
      await picker.selectOptions("basaltbytes/new-project");
      await document.fonts.ready;
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await commands.configurationEditorScreenshot(`779-repository-picker-${device}-${theme}`);
    } finally {
      flushSync(() => root.unmount());
      client.clear();
      host.remove();
      document.documentElement.classList.remove("dark");
      await commands.reducedMotion(false);
    }
  },
);
