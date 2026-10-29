import { ProjectDetail } from "~/features/configuration/components/projects/detail";
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
import { Page } from "~/components/page";
import { AgentDetail, AgentsList } from "~/features/configuration/components/agents";
import { LoopsList } from "~/features/configuration/components/loops/list";
import { LoopDetail } from "~/features/configuration/components/loops/detail";
import { interpolations } from "~/features/configuration/components/prompt";
import { usePauseLoop } from "~/features/configuration/queries";
import { RepositoriesList } from "~/features/configuration/components/repositories/list";
import { SettingsPage } from "~/features/configuration/settings.page";
import { WorkersList } from "~/features/configuration/components/workers/list";
import { WorkerDetail } from "~/features/configuration/components/workers/detail";
import { ConfigurationView } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import {
  configurationFixture,
  configurationJson,
  emptyConfiguration,
} from "~/lib/configuration/fixture";

const render = async (page: () => ReactNode): Promise<string> => {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree: createRootRoute({
      component: page,
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

type WithPauseProps = Readonly<{
  readonly children: (pause: ReturnType<typeof usePauseLoop>) => ReactNode;
}>;

const WithPause = ({ children }: WithPauseProps) => children(usePauseLoop());

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
    assert.include(page, 'Unknown agent "ghost": agents/ghost.md is missing or invalid');
    assert.include(page, "Not loaded");
    assert.include(page, 'item.labels.nodes.exists(label, label.name == "ready")');
    assert.include(markup, 'href="/configuration/loops/start-dev"');
    assert.include(page, "Paused");
    assert.include(page, "Resume");
  });

  it("offers no Pause or Resume while operator actions are unavailable", async () => {
    const markup = await render(() => (
      <LoopsList configuration={configurationFixture()} pause={null} />
    ));
    assert.deepStrictEqual(
      [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/gu)].map(([, label]) =>
        text(label ?? "").trim(),
      ),
      ["New"],
    );
  });

  it("says how to add a Loop when there is none", async () => {
    const page = text(
      await render(() => <LoopsList configuration={emptyConfiguration()} pause={null} />),
    );
    assert.include(page, "No loops");
    assert.include(page, "Choose New to add a loop");
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
    assert.include(page, "No selector: every registered repository");
    assert.include(page, "Condition uses an undeclared label: urgent");
    assert.include(markup, 'href="/configuration/agents/developer"');
    assert.include(page, "codex · gpt-5.6-sol · high");
    assert.include(markup, 'href="/configuration/repositories/basaltbytes/site"');
    assert.include(page, "Required");
    assert.include(page, "3 runs per item before a reset");
    assert.include(page, "Write: push and merge");
    assert.include(page, "None; runs wait in lane order");
    assert.include(page, "implement");
    assert.include(page, "4 outlined expressions filled in from each item");
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
    assert.include(page, "2 queued ahead of runs in lane order");
    assert.include(page, "Same text for every run");
  });

  it("shows why a quarantined Loop did not load and how to recover", async () => {
    const page = text(
      await render(() => (
        <LoopDetail name="ghost" configuration={configurationFixture()} pause={null} />
      )),
    );
    assert.include(page, "Unknown agent, repository, or tag");
    assert.include(page, 'Unknown agent "ghost": agents/ghost.md is missing or invalid');
    assert.include(page, "No runs until the file loads.");
    assert.include(page, "Fix loops/ghost.md , then reload the configuration.");
  });

  it("says when no Loop has the name", async () => {
    const page = text(
      await render(() => (
        <LoopDetail name="nope" configuration={configurationFixture()} pause={null} />
      )),
    );
    assert.include(page, "Loop not found");
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
    assert.include(page, "medium Set on this agent");
    assert.include(markup, 'href="/configuration/loops/start-dev"');
  });

  it("shows why an Agent file did not load", async () => {
    const page = text(
      await render(() => <AgentDetail name="broken" configuration={configurationFixture()} />),
    );
    assert.include(page, "Frontmatter is not valid YAML");
    assert.include(page, "Loops that use this agent are not loaded.");
  });

  it("says how to add an Agent when there is none", async () => {
    const page = text(await render(() => <AgentsList configuration={emptyConfiguration()} />));
    assert.include(page, "No agents");
  });
});

describe("Workers page", () => {
  it("lists each Worker with its slots in use and last preflight, then removed Workers", async () => {
    const page = text(await render(() => <WorkersList configuration={configurationFixture()} />));
    assert.include(page, "5 workers");
    assert.include(page, "1 of 2");
    assert.include(page, "usine@eu-1");
    assert.include(page, "Failed");
    assert.include(page, "Not checked");
    assert.include(page, "Degraded");
    assert.include(page, "spare removed by a reload, 1 attempt still running");
  });

  it("places a provisioned Worker by its machines, with a paused creation and deferred harness checks", async () => {
    const page = text(await render(() => <WorkersList configuration={configurationFixture()} />));
    assert.include(page, "hetzner cx33 in nbg1, one machine per attempt");
    assert.include(page, "boat default, one machine per attempt");
    assert.include(page, "Machine creation failed: quota reached. Next try at ");
    assert.match(page, /boat-pool .* Deferred 20 Oct/u);
  });

  it("shows a Hetzner Worker's provisioner by variable names only, and where its harnesses are checked", async () => {
    const page = text(
      await render(() => <WorkerDetail name="hz-pool" configuration={configurationFixture()} />),
    );
    for (const fact of [
      "Max attempts 3 at the same time, one machine each",
      "Provider Hetzner",
      "Server type cx33",
      "Location nbg1",
      "Image usine-worker-2026-10-24",
      "Network usine-private",
      "Firewall None",
      "SSH key usine-orchestrator",
      "SSH user usine",
      "Labels team=platform",
      "API token Read from HCLOUD_TOKEN",
      "Anthropic key Not set",
      "Provider, gateway, and credentials",
      "configured interval since the last successful check",
      "Deferred",
      "Checked on the first machine, then every 86400 seconds when a machine is created.",
    ]) {
      assert.include(page, fact);
    }
    assert.notInclude(page, "Port");
    assert.strictEqual(page.split("Destination").length, 2, "only the Gateway has a destination");
  });

  it("shows a Boat Worker's size and key variables, and that it has no machines", async () => {
    const page = text(
      await render(() => <WorkerDetail name="boat-pool" configuration={configurationFixture()} />),
    );
    assert.include(page, "Provider Boat");
    assert.include(page, "Size default");
    assert.include(page, "API token Read from BOAT_API_KEY");
    assert.include(page, "Anthropic key Read from ANTHROPIC_API_KEY");
    assert.include(page, "Machines Created for each attempt and deleted afterwards No machines");
    assert.notInclude(page, "Machine creation failed");
  });

  it("shows a Worker's slots and its last preflight per harness", async () => {
    const page = text(
      await render(() => <WorkerDetail name="local" configuration={configurationFixture()} />),
    );
    assert.include(page, "1 of 2 slots in use");
    assert.include(page, "Machine, Git, memory, gateway, and credentials");
    assert.include(page, "Failed: harness login");
    assert.include(page, "Claude Code needs a subscription login");
    assert.include(page, "Codex");
  });

  it("names a Gateway's admin token variable, and says when no preflight ran", async () => {
    const page = text(
      await render(() => <WorkerDetail name="eu-1" configuration={configurationFixture()} />),
    );
    assert.include(page, "Read from USINE_GATEWAY_ADMIN_TOKEN");
    assert.include(page, "/srv/usine");
    assert.include(page, "No preflight since usine up started.");
    assert.include(page, "Default for this release");
  });

  it("shows the container limits from usine.yaml, then the ones the last preflight derived", async () => {
    const configuration = configurationFixture();
    const before = text(
      await render(() => <WorkerDetail name="eu-1" configuration={configuration} />),
    );
    assert.include(
      before,
      "Limits 3584 MiB Derived from the machine at preflight: CPUs and processes",
    );

    const checked = Schema.decodeUnknownSync(ConfigurationView)({
      ...configurationJson,
      workers: configurationJson.workers.map((worker) =>
        worker.name === "eu-1"
          ? {
              ...worker,
              prerequisites: { _tag: "Passed", checkedAt: "2026-10-20T08:00:00.000Z" },
              containerLimits: { cpus: 1.16, memoryMib: 3584, pids: 20325 },
            }
          : worker,
      ),
    });
    const after = text(await render(() => <WorkerDetail name="eu-1" configuration={checked} />));
    assert.include(
      after,
      "Limits 1.16 CPUs, 3584 MiB, 20325 processes Derived from the machine at the last preflight: CPUs and processes",
    );
  });

  it("shows an SSH Worker without Docker as degraded, with the reason, and its container settings", async () => {
    const page = text(
      await render(() => <WorkerDetail name="eu-2" configuration={configurationFixture()} />),
    );
    assert.include(page, "Machine, Git, memory, gateway, credentials, and Docker");
    assert.include(page, "Degraded: no container per attempt");
    assert.include(page, "can read each other's credentials");
    assert.include(page, "registry.example/usine-worker:custom");
    assert.include(page, "1.5 CPUs, 6144 MiB, 2048 processes");
  });

  it("says that no Worker runs Attempts in setup mode", async () => {
    const configuration = configurationFixture();
    const setup = {
      ...configuration,
      workers: configuration.workers.map((worker) => ({ ...worker, slots: null })),
    };
    const page = text(await render(() => <WorkersList configuration={setup} />));
    assert.include(page, "No attempts run until the GitHub App is set up.");
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

  it("shows project repositories and lanes in configured order", async () => {
    const page = text(
      await render(() => <ProjectDetail id="usine" configuration={configurationFixture()} />),
    );
    assert.include(page, "Usine");
    assert.include(page, "basaltbytes/usine");
    assert.include(page, "Ready ready Review review");
  });

  it("says how to register a repository when there is none", async () => {
    const page = text(
      await render(() => <RepositoriesList configuration={emptyConfiguration()} />),
    );
    assert.include(page, "No repositories registered");
  });
});

describe("Settings page", () => {
  it("lists settings, the operator, the webhooks mode, and tracing with what each does", async () => {
    const page = text(await render(() => <SettingsPage configuration={configurationFixture()} />));
    assert.include(page, "settings.poll_interval 60");
    assert.include(page, "settings.max_attempt_minutes Not set No wall-clock ceiling");
    assert.include(page, "settings.max_attempt_tokens 20000000");
    assert.include(page, "operator PhilDL");
    assert.include(page, "webhooks.mode off");
    assert.include(page, "tracing.otlp_url http://localhost:4318/v1/traces");
    assert.include(page, "tracing.service_name usine-eu");
  });
});
