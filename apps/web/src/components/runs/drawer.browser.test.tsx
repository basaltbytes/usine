import { projectQuery } from "~/features/projects/queries";
import { projectTasksQuery } from "~/features/tasks/queries";
import { administratorPermissions } from "@usine/core/access";
import { PermissionsContext, sessionQuery } from "~/lib/permissions";
import { AgentSessionId, ParentSession, TextOutput } from "@usine/core/agent/session";
import { SessionEvent } from "@usine/core/attempt/channel";
import { TranscriptSequence } from "@usine/engine/transcript";
import {
  RunSummaryView,
  AttemptSummaryView,
  DeskView,
  TranscriptEventView,
  TranscriptPageCursor,
} from "@usine/orchestrator/operator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { SalvageRetained } from "@usine/core/attempt/salvage";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  MachineView,
  MachineQuotaWait,
  AgentFailureView,
  GitHubPushFailureView,
  ApprovalNeed,
  AttemptView,
  BoardItemLink,
  BoardView,
  FactoryOverview,
  FailedAttemptView,
  ProjectView,
  ReadyOverview,
  RunDetailView,
  RunFailureNeed,
  RunView,
  LocalWorkerAccess,
} from "@usine/orchestrator/operator";
import { Effect, Option, Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { overviewQuery, attentionQuery, projectId } from "~/lib/overview";
import { deskQuery } from "~/lib/desk/queries";
import { runDetailQuery } from "~/lib/runs/queries";
import { invalidateChanges } from "~/lib/changes";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { routeTree } from "~/route-tree.gen";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    loaderTranscriptResponses: (
      bodies: Readonly<Record<"cold" | "tail" | "empty" | "earlier" | "oldest", string>>,
    ) => Promise<void>;
    releaseEarlierTranscript: () => Promise<void>;
    loaderTranscriptRequests: () => Promise<
      ReadonlyArray<{ after: string | null; before: string | null; attempt: string | null }>
    >;
    failureResolutionResponses: (
      before: string,
      after: string,
      detailBefore: string,
      detailAfter: string,
      attemptId: string,
    ) => Promise<void>;
  }
}

const repository = RepositoryName.make("resolution/project");
const runId = RunId.make("resolution-run");
const attemptId = AttemptId.make("resolution-attempt");
const agent = AgentName.make("developer");
const loop = LoopName.make("implement");
const failure = AgentFailureView.make({ message: "Work was completed separately" });
const run = RunView.make({
  agentBrain: BrainSpec.make({
    harness: "codex",
    model: ModelId.make("test-model"),
    effort: "high",
  }),
  id: runId,
  itemKey: ItemKey.make("github:resolution/project:1"),
  repository,
  loop,
  agent,
  state: "Failed",
  loopPaused: false,
  openedAt: "2026-09-17T00:00:00Z",
  closedAt: "2026-09-17T00:20:00Z",
  task: "Complete the issue",
  attempts: [
    AttemptView.make({
      id: attemptId,
      number: AttemptNumber.make(1),
      worker: WorkerName.make("local"),
      workerAccess: LocalWorkerAccess.make(),
      brain: BrainSpec.make({ harness: "codex", model: ModelId.make("test"), effort: "high" }),
      task: AttemptTask.make("Complete the issue"),
      agent,
      operatorIntervened: false,
      startedAt: "2026-09-17T00:00:00Z",
      outcome: FailedAttemptView.make({ failure }),
      endedAt: "2026-09-17T00:20:00Z",
      salvage: null,
    }),
  ],
  approval: null,
  runAgain: null,
  resultMessage: null,
  pullRequestUrl: null,
  canApprove: false,
  canCancel: false,
  canRunAgain: false,
  canRetry: true,
  canResolveFailure: true,
});
const unrelated = ApprovalNeed.make({
  id: "other-approval",
  repository: RepositoryName.make("another/project"),
  runId: RunId.make("other-run"),
  loop,
  item: BoardItemLink.make({
    itemKey: ItemKey.make("github:another/project:7"),
    kind: "issue",
    number: ItemNumber.make(7),
    title: "Write the release notes",
    url: "https://github.com/another/project/issues/7",
    state: "issue-open",
  }),
});

it("resolves a failure from Needs attention while retaining unrelated attention, failed history, and retry, and shows why a retry is refused", async () => {
  const before = ReadyOverview.make({
    projects: [
      ProjectView.make({
        repository,
        status: "needs-you",
        runs: [
          RunSummaryView.make({
            ...run,
            attempts: run.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
          }),
        ],
        board: BoardView.make({ lanes: [], failures: [] }),
        labels: [],
        preflightFindings: [],
      }),
    ],
    loops: [],
    needsYou: [RunFailureNeed.make({ id: "failure", repository, runId, loop, failure }), unrelated],
  });
  const resolvedRun = RunView.make({ ...run, canResolveFailure: false });
  const after = ReadyOverview.make({
    ...before,
    needsYou: [unrelated],
    projects: before.projects.map((project) =>
      ProjectView.make({
        ...project,
        status: "clear",
        runs: [
          RunSummaryView.make({
            ...resolvedRun,
            attempts: resolvedRun.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
          }),
        ],
      }),
    ),
  });
  const detail = RunDetailView.make({
    agentDefinitionChanged: false,
    run,
    eventDedupKey: "event",
    eventPayload: {},
    transcript: [],
    sessionState: [],
    earlierTranscript: [],
  });
  await commands.failureResolutionResponses(
    JSON.stringify(await Effect.runPromise(Schema.encodeEffect(FactoryOverview)(before))),
    JSON.stringify(await Effect.runPromise(Schema.encodeEffect(FactoryOverview)(after))),
    JSON.stringify(await Effect.runPromise(Schema.encodeEffect(RunDetailView)(detail))),
    JSON.stringify(
      await Effect.runPromise(
        Schema.encodeEffect(RunDetailView)(RunDetailView.make({ ...detail, run: resolvedRun })),
      ),
    ),
    attemptId,
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  const cachedOverview = queryClient.getQueryData(overviewQuery().queryKey);
  if (cachedOverview !== undefined)
    queryClient.setQueryData(attentionQuery().queryKey, cachedOverview);
  for (const project of cachedOverview?.projects ?? []) {
    queryClient.setQueryData(projectQuery(projectId(project)).queryKey, project);
    queryClient.setQueryData(projectTasksQuery(projectId(project)).queryKey, project);
  }
  await router.load();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <PermissionsContext.Provider value={administratorPermissions}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </PermissionsContext.Provider>,
      ),
    );
    await page
      .getByRole("region", { name: "Run failed (1)" })
      .getByRole("button", { name: "Details", exact: true })
      .click();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Mark resolved", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "More actions", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .element(
        page.getByText('run newer-run of loop "implement" is open on the same item', {
          exact: false,
        }),
      )
      .toBeVisible();
    const drawer = page.getByRole("dialog");
    await expect.element(drawer.getByText("Agent failure", { exact: true })).toBeVisible();
    await expect
      .element(drawer.getByText("Work was completed separately", { exact: false }))
      .toBeVisible();
    // The labelled button in the body and the expand icon next to Close both link to the Run page.
    const toPage = drawer.getByRole("link", { name: "Open run page" });
    await expect.poll(() => toPage.elements().length).toBe(2);
    expect(new Set(toPage.elements().map((link) => link.getAttribute("href")))).toEqual(
      new Set(["/projects/resolution-project/runs/resolution-run"]),
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const needs = page.getByRole("region", { name: "Needs attention" });
    await expect
      .element(needs.getByRole("region", { name: "Run failed (1)", includeHidden: true }))
      .not.toBeInTheDocument();
    await expect
      .element(
        needs.getByRole("link", {
          name: /Write the release notes/,
          exact: true,
        }),
      )
      .toBeVisible();
    await expect.element(needs.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await needs.getByRole("button", { name: /^Actions for/ }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Cancel run", exact: true }))
      .toBeVisible();
    expect(
      queryClient.getQueryData<ReadyOverview>(overviewQuery().queryKey)?.projects[0]?.status,
    ).toBe("clear");
  } finally {
    flushSync(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});

it("marks a closed issue in its drawer and refreshes the agent definition warning after configuration changes", async () => {
  const onIssue = RunView.make({
    ...run,
    itemKey: ItemKey.make('["github","resolution/project",1]'),
  });
  const overview = JSON.stringify(
    await Effect.runPromise(
      Schema.encodeEffect(FactoryOverview)(
        ReadyOverview.make({
          projects: [
            ProjectView.make({
              repository,
              status: "needs-you",
              runs: [
                RunSummaryView.make({
                  ...onIssue,
                  attempts: onIssue.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
                }),
              ],
              board: BoardView.make({ lanes: [], failures: [] }),
              labels: [],
              preflightFindings: [],
            }),
          ],
          loops: [],
          needsYou: [unrelated],
        }),
      ),
    ),
  );
  const detail = JSON.stringify(
    await Effect.runPromise(
      Schema.encodeEffect(RunDetailView)(
        RunDetailView.make({
          agentDefinitionChanged: false,
          run: onIssue,
          eventDedupKey: "event",
          eventPayload: {},
          transcript: [],
          sessionState: [],
          earlierTranscript: [],
          settledItemState: "issue-closed",
        }),
      ),
    ),
  );
  await commands.failureResolutionResponses(overview, overview, detail, detail, attemptId);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/?run=${runId}`] }),
  });

  const cachedOverview = queryClient.getQueryData(overviewQuery().queryKey);
  if (cachedOverview !== undefined)
    queryClient.setQueryData(attentionQuery().queryKey, cachedOverview);
  for (const project of cachedOverview?.projects ?? []) {
    queryClient.setQueryData(projectQuery(projectId(project)).queryKey, project);
    queryClient.setQueryData(projectTasksQuery(projectId(project)).queryKey, project);
  }
  await router.load();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <PermissionsContext.Provider value={administratorPermissions}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </PermissionsContext.Provider>,
      ),
    );
    const drawer = page.getByRole("dialog");
    await expect
      .element(drawer.getByRole("link", { name: "Issue #1, closed", exact: true }))
      .toBeVisible();
    await expect.element(drawer.getByText("Agent failure", { exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "More actions", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Mark resolved", exact: true }))
      .toBeVisible();
    // The open drawer hides the rest of the page from assistive technology.
    const needs = page.getByRole("region", { name: "Needs attention", includeHidden: true });
    await expect
      .element(
        needs.getByRole("link", {
          name: /Write the release notes/,
          exact: true,
          includeHidden: true,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(needs.getByRole("region", { name: "Run failed (1)", includeHidden: true }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    const warning = drawer.getByText("The loaded definition of developer has changed.", {
      exact: false,
    });
    await expect.element(warning).not.toBeInTheDocument();
    const changed = JSON.stringify(
      await Effect.runPromise(
        Schema.encodeEffect(RunDetailView)(
          RunDetailView.make({
            ...(await Effect.runPromise(
              Schema.decodeEffect(Schema.fromJsonString(RunDetailView))(detail),
            )),
            agentDefinitionChanged: true,
          }),
        ),
      ),
    );
    await commands.failureResolutionResponses(overview, overview, changed, changed, attemptId);
    await invalidateChanges(
      queryClient,
      ChangeNotice.make({
        revision: 1,
        reset: false,
        changes: [{ kind: "configuration", id: "instance" }],
      }),
    );
    await expect.element(warning).toBeVisible();
  } finally {
    flushSync(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});

it("refreshes an open queued run during machine preparation and quota backoff", async () => {
  const queued = RunView.make({
    ...run,
    state: "Queued",
    closedAt: null,
    attempts: [],
    canRetry: false,
    canResolveFailure: false,
  });
  const machine = MachineView.make({
    worker: WorkerName.make("pool"),
    provider: "hetzner",
    state: "creating",
    id: null,
    runId,
    attemptId,
    since: "2026-09-17T00:00:00Z",
  });
  const detail = RunDetailView.make({
    run: queued,
    machine,
    agentDefinitionChanged: false,
    eventDedupKey: "event",
    eventPayload: {},
    transcript: [],
    sessionState: [],
    earlierTranscript: [],
  });
  const overview = ReadyOverview.make({
    projects: [
      ProjectView.make({
        repository,
        status: "clear",
        runs: [
          RunSummaryView.make({
            ...queued,
            attempts: queued.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
          }),
        ],
        board: BoardView.make({ lanes: [], failures: [] }),
        labels: [],
        preflightFindings: [],
      }),
    ],
    loops: [],
    needsYou: [],
  });
  const overviewJson = JSON.stringify(
    await Effect.runPromise(Schema.encodeEffect(FactoryOverview)(overview)),
  );
  const serve = (next: RunDetailView) => {
    const json = JSON.stringify(Effect.runSync(Schema.encodeEffect(RunDetailView)(next)));
    return commands.failureResolutionResponses(overviewJson, overviewJson, json, json, attemptId);
  };
  await serve(detail);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/?run=${runId}`] }),
  });
  await router.load();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const refresh = () =>
    invalidateChanges(
      queryClient,
      ChangeNotice.make({
        revision: 1,
        reset: false,
        changes: [{ kind: "run", id: runId }],
      }),
    );
  try {
    flushSync(() =>
      root.render(
        <PermissionsContext.Provider value={administratorPermissions}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </PermissionsContext.Provider>,
      ),
    );
    const drawer = page.getByRole("dialog");
    await expect.element(drawer.getByText(/^Creating a Hetzner machine,/)).toBeVisible();
    const preparing = RunDetailView.make({
      ...detail,
      machine: MachineView.make({ ...machine, state: "preparing" }),
    });
    await serve(preparing);
    await refresh();
    await expect.element(drawer.getByText(/^Preparing the attempt image,/)).toBeVisible();
    const message = "shared core limit exceeded";
    await serve(
      RunDetailView.make({
        ...detail,
        machine: null,
        run: RunView.make({
          ...queued,
          machineWait: MachineQuotaWait.make({ worker: machine.worker, message }),
        }),
      }),
    );
    await refresh();
    await expect.element(drawer.getByText(message, { exact: false }).first()).toBeVisible();
    await serve(preparing);
    await refresh();
    await expect
      .element(drawer.getByText(message, { exact: false }).first())
      .not.toBeInTheDocument();
    await expect.element(drawer.getByText(/^Preparing the attempt image,/)).toBeVisible();
  } finally {
    flushSync(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});

it("shares a direct-link drawer's transcript with the run page and merges earlier pages around a tail refetch", async () => {
  const id = RunId.make("loader-run");
  const viewed = RunView.make({ ...run, id });
  const parent = ParentSession.make({
    id: AgentSessionId.make("loader-parent"),
    agent,
    brain: run.agentBrain,
  });
  const message = (sequence: number) =>
    TranscriptEventView.make({
      sequence: TranscriptSequence.make(sequence),
      attemptId,
      receivedAt: "2026-09-17T00:10:00Z",
      direction: "outbound",
      payload: SessionEvent.make({
        event: TextOutput.make({ session: parent, text: `Transcript message ${sequence}` }),
      }),
    });
  const detail = (sequences: ReadonlyArray<number>, before: number | null) =>
    RunDetailView.make({
      run: viewed,
      agentDefinitionChanged: false,
      eventDedupKey: "event",
      eventPayload: {},
      transcript: sequences.map(message),
      sessionState: [],
      earlierTranscript:
        before === null
          ? []
          : [TranscriptPageCursor.make({ attemptId, before: TranscriptSequence.make(before) })],
    });
  const encode = (sequences: ReadonlyArray<number>, before: number | null) =>
    JSON.stringify(Effect.runSync(Schema.encodeEffect(RunDetailView)(detail(sequences, before))));
  await commands.loaderTranscriptResponses({
    cold: encode([3, 4], 3),
    tail: encode([5], null),
    empty: encode([], null),
    earlier: encode([2], 2),
    oldest: encode([1], null),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(
    overviewQuery().queryKey,
    ReadyOverview.make({
      projects: [
        ProjectView.make({
          repository,
          status: "clear",
          runs: [
            RunSummaryView.make({
              ...viewed,
              attempts: viewed.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
            }),
          ],
          board: BoardView.make({ lanes: [], failures: [] }),
          labels: [],
          preflightFindings: [],
        }),
      ],
      loops: [],
      needsYou: [],
    }),
  );
  queryClient.setQueryData(
    deskQuery().queryKey,
    DeskView.make({ running: [], notMoving: [], lastOutcomes: [], workers: [], polls: [] }),
  );
  const options = runDetailQuery(queryClient, id);
  queryClient.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/projects/${repository}?run=${id}`] }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const cachedOverview = queryClient.getQueryData(overviewQuery().queryKey);
    if (cachedOverview !== undefined)
      queryClient.setQueryData(attentionQuery().queryKey, cachedOverview);
    for (const project of cachedOverview?.projects ?? []) {
      queryClient.setQueryData(projectQuery(projectId(project)).queryKey, project);
      queryClient.setQueryData(projectTasksQuery(projectId(project)).queryKey, project);
    }
    await router.load();
    expect(queryClient.getQueryState(options.queryKey)?.error).toBeNull();
    expect(
      queryClient.getQueryData(options.queryKey)?.transcript.map(({ sequence }) => sequence),
    ).toEqual([3, 4]);
    flushSync(() =>
      root.render(
        <PermissionsContext.Provider value={administratorPermissions}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </PermissionsContext.Provider>,
      ),
    );
    const drawer = page.getByRole("dialog");
    await expect.element(drawer.getByText("Agent failure", { exact: true })).toBeVisible();
    await drawer.getByRole("link", { name: "Open run page", exact: true }).first().click();
    await expect
      .element(page.getByRole("button", { name: "Load earlier", exact: true }))
      .toBeVisible();
    expect(
      (await commands.loaderTranscriptRequests()).filter(
        ({ after, before }) => after === null && before === null,
      ),
    ).toHaveLength(1);
    await page.getByRole("button", { name: "Load earlier", exact: true }).click();
    await expect
      .poll(async () =>
        (await commands.loaderTranscriptRequests()).some(
          ({ before, attempt }) => before === "3" && attempt === attemptId,
        ),
      )
      .toBe(true);
    await queryClient.invalidateQueries({ queryKey: options.queryKey });
    await commands.releaseEarlierTranscript();
    await expect
      .poll(() => queryClient.getQueryData(options.queryKey)?.earlierTranscript[0]?.before)
      .toBe(2);
    await page.getByRole("button", { name: "Load earlier", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Load earlier", exact: true }))
      .not.toBeInTheDocument();
    expect(queryClient.getQueryState(options.queryKey)?.error).toBeNull();
    await expect
      .poll(() =>
        queryClient.getQueryData(options.queryKey)?.transcript.map(({ sequence }) => sequence),
      )
      .toEqual([1, 2, 3, 4, 5]);
    expect(await commands.loaderTranscriptRequests()).toContainEqual({
      after: null,
      before: "2",
      attempt: attemptId,
    });
    await expect
      .element(page.getByText("Transcript message 1", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Transcript message 5", { exact: true }))
      .toBeInTheDocument();
  } finally {
    flushSync(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});

it("shows the push refusal on the run page and in Needs attention alongside retained salvage", async () => {
  const message =
    "GitHub refused the push to resolution/project at refs/heads/usine/salvage/resolution-run/1 (HTTP 403). The token is a single-repository installation token. GitHub's message: Permission to resolution/project.git denied to usine-test[bot].";
  const pushFailure = GitHubPushFailureView.make({ message });
  const retained = SalvageRetained.make({
    path: "/worker/checkout",
    commit: Option.none(),
    message,
  });
  const failedRun = RunView.make({
    ...run,
    attempts: run.attempts.map((attempt) =>
      AttemptView.make({
        ...attempt,
        outcome: FailedAttemptView.make({ failure: pushFailure }),
        salvage: retained,
      }),
    ),
  });
  const overview = ReadyOverview.make({
    projects: [
      ProjectView.make({
        repository,
        status: "needs-you",
        runs: [
          RunSummaryView.make({
            ...failedRun,
            attempts: failedRun.attempts.map((attempt) => AttemptSummaryView.make(attempt)),
          }),
        ],
        board: BoardView.make({ lanes: [], failures: [] }),
        labels: [],
        preflightFindings: [],
      }),
    ],
    loops: [],
    needsYou: [
      RunFailureNeed.make({ id: "push-refused", repository, runId, loop, failure: pushFailure }),
    ],
  });
  const detail = RunDetailView.make({
    agentDefinitionChanged: false,
    run: failedRun,
    eventDedupKey: "event",
    eventPayload: {},
    transcript: [],
    sessionState: [],
    earlierTranscript: [],
  });
  const overviewJson = JSON.stringify(
    await Effect.runPromise(Schema.encodeEffect(FactoryOverview)(overview)),
  );
  const detailJson = JSON.stringify(
    await Effect.runPromise(Schema.encodeEffect(RunDetailView)(detail)),
  );
  await commands.failureResolutionResponses(
    overviewJson,
    overviewJson,
    detailJson,
    detailJson,
    attemptId,
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionQuery().queryKey, { permissions: administratorPermissions });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/projects/${repository}/runs/${runId}`] }),
  });

  const cachedOverview = queryClient.getQueryData(overviewQuery().queryKey);
  if (cachedOverview !== undefined)
    queryClient.setQueryData(attentionQuery().queryKey, cachedOverview);
  for (const project of cachedOverview?.projects ?? []) {
    queryClient.setQueryData(projectQuery(projectId(project)).queryKey, project);
    queryClient.setQueryData(projectTasksQuery(projectId(project)).queryKey, project);
  }
  await router.load();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <PermissionsContext.Provider value={administratorPermissions}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </PermissionsContext.Provider>,
      ),
    );
    await page.getByRole("button", { name: "Needs attention (1)", exact: true }).click();
    const needs = page.getByRole("dialog", { name: "Needs attention 1" });
    await expect.element(needs.getByRole("button", { name: "Details", exact: true })).toBeVisible();
    await expect
      .element(needs.getByText("implement · resolution/project", { exact: false }))
      .toHaveAttribute("title", message);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("GitHub refused push", { exact: true })).toBeVisible();
    await expect.element(page.getByText(message, { exact: true }).last()).toBeVisible();
    await expect.element(page.getByText("/worker/checkout", { exact: true })).toBeVisible();
  } finally {
    flushSync(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});
