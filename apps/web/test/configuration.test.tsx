import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { Page } from "../src/components/page.tsx";
import { AgentDetail, AgentsList } from "../src/configuration/agents.tsx";
import { LoopDetail, LoopsList } from "../src/configuration/loops.tsx";
import { interpolations } from "../src/configuration/prompt.tsx";
import { usePauseLoop } from "../src/configuration/query.ts";
import { SectionReloadProvider } from "../src/configuration/reload.tsx";
import { RepositoriesList, RepositoryDetail } from "../src/configuration/repositories.tsx";
import { SettingsPage } from "../src/configuration/settings.tsx";
import { WorkerDetail, WorkersList } from "../src/configuration/workers.tsx";
import { configurationFixture, emptyConfiguration } from "./configuration-fixture.ts";

/** Renders a Configuration page inside a router and the section's reload, as its route does. */
const render = async (page: () => ReactNode): Promise<string> => {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <SectionReloadProvider>{page()}</SectionReloadProvider>,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

const text = (markup: string): string =>
  markup
    .replace(/<[^>]+>/gu, " ")
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ");

const WithPause = ({
  children,
}: {
  readonly children: (pause: ReturnType<typeof usePauseLoop>) => ReactNode;
}) => children(usePauseLoop());

describe("Page shell", () => {
  it("stops prose pages at 768px and lets full pages fill the panel", () => {
    assert.include(renderToStaticMarkup(<Page>Projects</Page>), "max-w-3xl");
    assert.include(renderToStaticMarkup(<Page width="prose">Projects</Page>), "max-w-3xl");
    assert.notInclude(renderToStaticMarkup(<Page width="full">Loops</Page>), "max-w-3xl");
  });
});

describe("Loops page", () => {
  it("lists the files that did not load first, then each Loop with its trigger and state", async () => {
    const markup = await render(() => (
      <WithPause>
        {(pause) => <LoopsList configuration={configurationFixture()} pause={pause} />}
      </WithPause>
    ));
    const page = text(markup);
    assert.include(page, "2 loops, 1 paused, 1 not loaded");
    assert.isBelow(page.indexOf("ghost"), page.indexOf("start-dev"));
    assert.include(page, "Unknown agent: ghost");
    assert.include(page, "Not loaded");
    assert.include(page, 'item.labels.nodes.exists(label, label.name == "ready")');
    assert.include(markup, 'href="/configuration/loops/start-dev"');
    assert.include(page, "Paused");
    assert.include(page, "Resume");
    assert.include(page, "Reload configuration");
  });

  it("offers no Pause or Resume while operator actions are unavailable", async () => {
    const markup = await render(() => (
      <LoopsList configuration={configurationFixture()} pause={null} />
    ));
    assert.deepStrictEqual(
      [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/gu)].map(([, label]) =>
        text(label ?? "").trim(),
      ),
      ["Reload configuration"],
    );
  });

  it("says how to add a Loop when there is none", async () => {
    const page = text(
      await render(() => <LoopsList configuration={emptyConfiguration()} pause={null} />),
    );
    assert.include(page, "No Loops");
    assert.include(page, "loops/");
  });

  it("shows a Loop's trigger and selector verbatim, its facts, and its prompt with marked expressions", async () => {
    const markup = await render(() => (
      <WithPause>
        {(pause) => (
          <LoopDetail name="start-dev" configuration={configurationFixture()} pause={pause} />
        )}
      </WithPause>
    ));
    const page = text(markup);
    assert.include(page, "loops/start-dev.md");
    assert.include(
      page,
      'if: item.labels.nodes.exists(label, label.name == "ready") && item.assignees.totalCount == 0',
    );
    assert.include(page, "No selector, so the Loop applies to every registered repository.");
    assert.include(page, "The condition names urgent");
    assert.include(markup, 'href="/configuration/agents/developer"');
    assert.include(page, "codex · gpt-5.6-sol · high");
    assert.include(markup, 'href="/configuration/repositories/basaltbytes/site"');
    assert.include(page, "Required");
    assert.include(page, "3 Runs per Item before a reset");
    assert.include(page, "Write: push and merge");
    assert.include(page, "implement");
    assert.include(page, "4 outlined expressions filled in from each Item");
    assert.strictEqual(markup.match(/<mark/gu)?.length, 4);
    assert.include(markup, "<strong>");
    assert.include(markup, "<code>pnpm test</code>");
    assert.include(page, "Pause");
  });

  it("shows a selector as the file states it", async () => {
    const page = text(
      await render(() => (
        <LoopDetail name="review-pr" configuration={configurationFixture()} pause={null} />
      )),
    );
    assert.include(page, "tags: engine");
    assert.include(page, "Read: review and comment, no push");
    assert.include(page, "Every Run receives it as written");
  });

  it("shows why a quarantined Loop did not load and how to recover", async () => {
    const page = text(
      await render(() => (
        <LoopDetail name="ghost" configuration={configurationFixture()} pause={null} />
      )),
    );
    assert.include(page, "It names something the configuration does not have");
    assert.include(page, "Unknown agent: ghost");
    assert.include(page, "The Loop opens no Runs until the file loads.");
    assert.include(page, "Fix loops/ghost.md , then reload the configuration.");
  });

  it("says when no Loop has the name", async () => {
    const page = text(
      await render(() => (
        <LoopDetail name="nope" configuration={configurationFixture()} pause={null} />
      )),
    );
    assert.include(page, "No Loop by this name");
  });

  it("finds the expressions of a prompt template", () => {
    assert.deepStrictEqual(interpolations("a {{ item.number }} b {{repo.name}}"), [
      "item.number",
      "repo.name",
    ]);
  });
});

describe("Agents page", () => {
  it("lists the roster with each brain and the Loops that name it", async () => {
    const markup = await render(() => <AgentsList configuration={configurationFixture()} />);
    const page = text(markup);
    assert.include(page, "2 agents, 1 not loaded");
    assert.include(page, "Codex");
    assert.include(page, "gpt-5.6-sol");
    assert.include(page, "Flow sequence in block collection");
    assert.include(markup, 'href="/configuration/agents/reviewer"');
  });

  it("shows an Agent's persona and where its parent settings come from", async () => {
    const markup = await render(() => (
      <AgentDetail name="developer" configuration={configurationFixture()} />
    ));
    const page = text(markup);
    assert.include(markup, "<li>Keep changes small.</li>");
    assert.include(page, "openai-codex/gpt-5.6-terra From settings.parent_model");
    assert.include(page, "medium Set in this file");
    assert.include(markup, 'href="/configuration/loops/start-dev"');
  });

  it("shows why an Agent file did not load", async () => {
    const page = text(
      await render(() => <AgentDetail name="broken" configuration={configurationFixture()} />),
    );
    assert.include(page, "The frontmatter is not valid YAML");
    assert.include(page, "every Loop that names it is quarantined");
  });

  it("says how to add an Agent when there is none", async () => {
    const page = text(await render(() => <AgentsList configuration={emptyConfiguration()} />));
    assert.include(page, "No Agents");
  });
});

describe("Workers page", () => {
  it("lists each Worker with its slots in use and last preflight, then removed Workers", async () => {
    const page = text(await render(() => <WorkersList configuration={configurationFixture()} />));
    assert.include(page, "2 workers");
    assert.include(page, "1 of 2");
    assert.include(page, "usine@eu-1");
    assert.include(page, "Failed");
    assert.include(page, "Not checked");
    assert.include(page, "spare was removed by a reload and still runs 1 Attempt");
  });

  it("shows a Worker's slots and its last preflight per harness", async () => {
    const page = text(
      await render(() => <WorkerDetail name="local" configuration={configurationFixture()} />),
    );
    assert.include(page, "1 of 2 slots in use");
    assert.include(page, "Machine, Git, memory, Gateway, and credentials");
    assert.include(page, "Failed: harness login");
    assert.include(page, "Claude Code is not logged in on Worker local");
    assert.include(page, "Codex");
  });

  it("names a Gateway's admin token variable, and says when no preflight ran", async () => {
    const page = text(
      await render(() => <WorkerDetail name="eu-1" configuration={configurationFixture()} />),
    );
    assert.include(page, "Read from USINE_GATEWAY_ADMIN_TOKEN");
    assert.include(page, "/srv/usine");
    assert.include(page, "No preflight has run on this Worker since usine up started.");
  });

  it("says that no Worker runs Attempts in setup mode", async () => {
    const configuration = configurationFixture();
    const setup = {
      ...configuration,
      workers: configuration.workers.map((worker) => ({ ...worker, slots: null })),
    };
    const page = text(await render(() => <WorkersList configuration={setup} />));
    assert.include(page, "No Worker runs Attempts until the GitHub App is set up.");
  });
});

describe("Repositories page", () => {
  it("lists each repository with its lanes and label standing", async () => {
    const page = text(
      await render(() => <RepositoriesList configuration={configurationFixture()} />),
    );
    assert.include(page, "2 repositories");
    assert.include(page, "1 failed, 1 missing on GitHub");
    assert.include(page, "Proposed");
    assert.include(page, "Not polled yet");
  });

  it("shows lanes in order with each label as GitHub has it", async () => {
    const markup = await render(() => (
      <RepositoryDetail owner="basaltbytes" name="usine" configuration={configurationFixture()} />
    ));
    const page = text(markup);
    assert.isBelow(page.indexOf("Ready"), page.indexOf("In review"));
    assert.include(page, "GitHub rejected the request with status 403");
    assert.include(page, "pr-open");
    assert.include(page, "On GitHub");
    assert.include(markup, 'href="/projects/basaltbytes/usine"');
  });

  it("explains a repository without lanes", async () => {
    const page = text(
      await render(() => (
        <RepositoryDetail owner="basaltbytes" name="site" configuration={configurationFixture()} />
      )),
    );
    assert.include(page, "declares no lanes for this repository");
  });

  it("says how to register a repository when there is none", async () => {
    const page = text(
      await render(() => <RepositoriesList configuration={emptyConfiguration()} />),
    );
    assert.include(page, "No repositories registered");
  });
});

describe("Settings page", () => {
  it("lists settings, the operator, and the webhooks mode with what each does", async () => {
    const page = text(await render(() => <SettingsPage configuration={configurationFixture()} />));
    assert.include(page, "settings.poll_interval 60");
    assert.include(page, "settings.max_attempt_minutes Not set No wall-clock ceiling");
    assert.include(page, "settings.max_attempt_tokens 20000000");
    assert.include(page, "operator PhilDL");
    assert.include(page, "webhooks.mode off");
  });
});
