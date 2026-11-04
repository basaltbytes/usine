import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import {
  administratorPermissions,
  GitHubUserId,
  InstanceScope,
  ProjectScope,
  RoleBinding,
} from "@usine/core/access";
import { RunId } from "@usine/core/run";
import { LoopName } from "@usine/core/loop";
import { ProjectId } from "@usine/core/project";
import {
  RunSummaryView,
  AttemptSummaryView,
  ConfigurationView,
  FactoryOverview,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunView,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { configurationFixture } from "~/lib/configuration/fixture";
import { taskOverview, fullTask } from "~/lib/tasks/fixture";
import { sessionQuery } from "~/lib/permissions";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    accessResponses: (configuration: string, permissions: string) => Promise<void>;
  }
}

it.each([1440, 390])(
  "shows role bindings and token scopes and hides viewer actions at %i pixels",
  async (width) => {
    await page.viewport(width, width === 390 ? 844 : 900);
    await commands.reducedMotion(true);
    const bindings = [
      RoleBinding.make({
        name: "instance-admin",
        member: GitHubUserId.make(1),
        role: "admin",
        scope: InstanceScope.make(),
      }),
      RoleBinding.make({
        name: "project-operator",
        member: GitHubUserId.make(2),
        role: "operator",
        scope: ProjectScope.make({ project: ProjectId.make("usine") }),
      }),
      RoleBinding.make({
        name: "project-viewer",
        member: GitHubUserId.make(3),
        role: "viewer",
        scope: ProjectScope.make({ project: ProjectId.make("usine") }),
      }),
    ];
    const configuration = ConfigurationView.make({ ...configurationFixture(), bindings });
    const configurationJson = JSON.stringify(Schema.encodeSync(ConfigurationView)(configuration));
    await commands.configurationEditorResponses([], configurationJson);
    await commands.accessResponses(configurationJson, JSON.stringify(administratorPermissions));
    const template = fullTask().runs[0];
    if (template === undefined) throw new Error("Missing waiting run fixture");
    const run = RunView.make({
      ...template,
      id: RunId.make("approval-run"),
      loop: LoopName.make("usine/fix-ci"),
    });
    const overview = ReadyOverview.make({
      ...taskOverview(),
      projects: taskOverview().projects.map((project) =>
        ProjectView.make({
          ...project,
          id: ProjectId.make("usine"),
          runs: [
            RunSummaryView.make({
              ...run,
              attempts: run.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
            }),
          ],
        }),
      ),
      needsYou: [],
    });
    const overviewJson = JSON.stringify(Schema.encodeSync(FactoryOverview)(overview));
    const detail = RunDetailView.make({
      run,
      agentDefinitionChanged: false,
      eventDedupKey: "roles-capture",
      eventPayload: {},
      transcript: [],
      sessionState: [],
      earlierTranscript: [],
    });
    const detailJson = JSON.stringify(Schema.encodeSync(RunDetailView)(detail));
    await commands.approvalResponses(overviewJson, overviewJson, detailJson, detailJson);
    await commands.githubChangesResponse('{"attempts":[]}');
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
    try {
      await router.load();
      flushSync(() =>
        root.render(
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
        ),
      );
      for (const theme of ["dark", "light"]) {
        document.documentElement.classList.toggle("dark", theme === "dark");
        await commands.accessResponses(configurationJson, JSON.stringify(administratorPermissions));
        client.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
        await router.navigate({ to: "/members" });
        await expect.element(page.getByRole("columnheader", { name: "Bindings" })).toBeVisible();
        for (const [role, name] of [
          ["admin · Instance", "instance-admin"],
          ["operator · usine", "project-operator"],
          ["viewer · usine", "project-viewer"],
        ] as const) {
          await expect
            .element(page.getByRole("link", { name: role, exact: true }))
            .toHaveAttribute("href", `/configuration/bindings/${name}`);
        }
        await expect.element(page.getByText("No bindings", { exact: true })).toBeVisible();
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
        await commands.configurationEditorScreenshot(`776-members-${device}-${theme}`);
        for (const binding of bindings) {
          await router.navigate({
            to: "/configuration/bindings/$binding",
            params: { binding: binding.name },
          });
          await page.getByRole("button", { name: "Edit", exact: true }).click();
          const source = page.getByRole("textbox", { name: "Configuration text", exact: true });
          await expect
            .element(source)
            .toHaveValue(expect.stringContaining(`role: ${binding.role}`));
          await commands.configurationEditorScreenshot(`776-${binding.name}-${device}-${theme}`);
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
        }
        await router.navigate({ to: "/tokens" });
        await page.getByLabelText("Token name").fill("Project automation");
        await page.getByRole("checkbox", { name: "Read · usine", exact: true }).click();
        await page.getByRole("checkbox", { name: "Operate · usine", exact: true }).click();
        await expect
          .element(page.getByRole("button", { name: "Create token", exact: true }))
          .toBeVisible();
        await commands.configurationEditorScreenshot(`776-tokens-${device}-${theme}`);
        await expect
          .element(page.getByRole("checkbox", { name: "Read · usine", exact: true }))
          .toBeChecked();
        await expect
          .element(page.getByRole("checkbox", { name: "Operate · usine", exact: true }))
          .toBeChecked();
        await router.navigate({
          to: "/projects/$project/runs/$run",
          params: { project: "usine", run: run.id },
        });
        await expect
          .element(page.getByRole("button", { name: "Approve", exact: true }))
          .toBeVisible();
        await page.getByRole("button", { name: "More actions", exact: true }).click();
        await expect
          .element(page.getByRole("menuitem", { name: "Cancel run", exact: true }))
          .toBeVisible();
        await userEvent.keyboard("{Escape}");
        const viewer = bindings[2];
        if (viewer === undefined) throw new Error("Missing viewer fixture");
        await commands.accessResponses(configurationJson, JSON.stringify(viewer.permissions));
        client.setQueryData(sessionQuery().queryKey, { permissions: viewer.permissions });
        await router.navigate({
          to: "/projects/$project/runs/$run",
          params: { project: "usine", run: run.id },
        });
        await expect
          .element(page.getByText("Waiting for approval", { exact: true }).first())
          .toBeVisible();
        await expect
          .element(page.getByRole("button", { name: "Approve", exact: true }))
          .not.toBeInTheDocument();
        await expect
          .element(page.getByRole("button", { name: "Cancel run", exact: true }))
          .not.toBeInTheDocument();
        await expect
          .element(page.getByRole("group", { name: "Run actions", exact: true }))
          .not.toBeInTheDocument();
        await commands.configurationEditorScreenshot(`776-viewer-run-${device}-${theme}`);
      }
    } finally {
      flushSync(() => root.unmount());
      client.clear();
      host.remove();
      document.documentElement.classList.remove("dark");
      await commands.reducedMotion(false);
    }
  },
);
