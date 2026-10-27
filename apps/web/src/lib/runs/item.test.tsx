import { LaneName, type SettledItemState } from "@usine/config/board";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  ProviderRetries,
  ProviderRetrying,
  TextOutput,
  TokenCount,
  ToolStarted,
  UsdAmount,
} from "@usine/core/agent/session";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { SessionEvent, WorkerUnresponsive } from "@usine/core/attempt/channel";
import {
  SalvagePartlyPushed,
  SalvagePushed,
  SalvageRef,
  SalvageRejected,
  SalvageRetained,
} from "@usine/core/attempt/salvage";
import {
  StartedAfterRestart,
  StartedByEditAndRetry,
  StartedByEvent,
  StartedByInfraRetry,
  StartedByRetry,
} from "@usine/core/attempt/start";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import { ApprovalSource } from "@usine/core/run/approval";
import { WorkerName } from "@usine/core/worker";
import { TranscriptSequence } from "@usine/engine/transcript";
import {
  AgentFailureView,
  ApprovalView,
  BoardItemLink,
  BoardLaneId,
  BoardTaskView,
  BoardView,
  AttemptView,
  CanceledAttemptView,
  FailedAttemptView,
  PoolUsageView,
  QuestionFailureView,
  RunDetailView,
  RunDurationView,
  RunUsageView,
  RunView,
  SessionUsageView,
  SucceededAttemptView,
  ProjectView,
  ReadOnlyBoardLaneView,
  ReadyOverview,
  TranscriptEventView,
  UsageCostView,
  LocalWorkerAccess,
} from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { DateTime, Option, Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { clockLabel, dayTimeLabel } from "~/lib/strings";
import { RunSummary } from "~/components/runs/drawer";
import { EventDocument } from "~/features/runs/components/documents";
import { RunHeader } from "~/components/runs/header";
import { taskUsageOf } from "~/lib/projects/fixture";
import { UsageBreakdown } from "~/components/runs/usage";
import { eventPreview, runItem } from "~/lib/runs/item";
import { Outline } from "~/features/runs/components/outline/outline";
import { readerDocument } from "~/lib/runs/transcript/document/model";
import { projectTranscript } from "~/lib/runs/transcript/model";
import { SalvageLine } from "~/components/runs/transcript/outcome";
import { machineFixture } from "~/lib/runs/machine-fixture";
import { WithRouter } from "~/lib/testing/memory-router";

const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(33)]);
const brain = new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "high" });
const attemptId = AttemptId.make("attempt-1");
const attempt = (outcome: AttemptView["outcome"], salvage: AttemptView["salvage"] = null) =>
  new AttemptView({
    id: attemptId,
    number: AttemptNumber.make(1),
    worker: WorkerName.make("local"),
    workerAccess: new LocalWorkerAccess(),
    brain,
    task: AttemptTask.make("Fix issue 33."),
    agent: AgentName.make("developer"),
    operatorIntervened: false,
    startedAt: "2026-09-01T12:00:00.000Z",
    outcome,
    endedAt: outcome === null ? null : "2026-09-01T12:25:00.000Z",
    salvage,
  });
const run = (fields: Partial<ConstructorParameters<typeof RunView>[0]> = {}) =>
  new RunView({
    agentBrain: brain,
    id: RunId.make("run-33"),
    itemKey,
    loop: LoopName.make("start-dev"),
    repository,
    agent: AgentName.make("developer"),
    state: "Succeeded",
    loopPaused: false,
    openedAt: "2026-09-01T11:59:00.000Z",
    closedAt: "2026-09-01T12:25:00.000Z",
    task: "Fix issue 33.",
    attempts: [attempt(new SucceededAttemptView())],
    approval: null,
    runAgain: null,
    resultMessage: "Opened the pull request.",
    pullRequestUrl: null,
    canApprove: false,
    canRetry: false,
    canResolveFailure: false,
    canCancel: false,
    canRunAgain: false,
    ...fields,
  });
const detail = (view: RunView, transcript: ReadonlyArray<TranscriptEventView> = []) =>
  new RunDetailView({
    agentDefinitionChanged: false,
    run: view,
    eventDedupKey: '["start-dev","basaltbytes/usine",33]',
    eventPayload: {
      number: 33,
      title: "Board lanes",
      url: "https://github.com/basaltbytes/usine/issues/33",
      state: "OPEN",
      labels: { totalCount: 1, nodes: [{ name: "ready-for-agent" }] },
    },
    transcript,
    sessionState: [],
    earlierTranscript: [],
  });
const member = (
  number: number,
  kind: "issue" | "pr",
  state: BoardItemLink["state"],
  title = "Board lanes",
) =>
  new BoardItemLink({
    itemKey: Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(number)]),
    kind,
    number: ItemNumber.make(number),
    title,
    url: `https://github.com/basaltbytes/usine/${kind === "pr" ? "pull" : "issues"}/${number}`,
    state,
  });
/** Returns an overview whose Board shows one Task with `members`. */
const overviewWith = (members: readonly [BoardItemLink, ...Array<BoardItemLink>]) => {
  const current = members.at(-1) ?? members[0];
  return new ReadyOverview({
    projects: [
      new ProjectView({
        repository,
        status: "clear",
        runs: [],
        board: new BoardView({
          lanes: [
            new ReadOnlyBoardLaneView({
              id: BoardLaneId.make("fallback:all"),
              name: LaneName.make("All"),
              sources: [],
              origin: "fallback",
              items: [
                new BoardTaskView({
                  ...current,
                  title: members[0].title,
                  labels: [],
                  items: members,
                  pullRequest: null,
                  runs: [],
                  run: null,
                  needsYou: false,
                  conflicting: false,
                  loops: [],
                  usage: taskUsageOf([]),
                }),
              ],
            }),
          ],
          failures: [],
        }),
        labels: [],
        preflightFindings: [],
      }),
    ],
    loops: [],
    needsYou: [],
  });
};
/** Renders the Run header for Item #33; `members` are the items of its Task on the Board. */
const heading = (
  view: RunDetailView,
  {
    payload = view.eventPayload,
    shared = false,
    placement = "page",
    members,
  }: {
    readonly payload?: Schema.Json;
    readonly shared?: boolean;
    readonly placement?: "page" | "drawer";
    readonly members?: readonly [BoardItemLink, ...Array<BoardItemLink>];
  } = {},
) =>
  renderToStaticMarkup(
    <RunHeader
      detail={new RunDetailView({ ...view, eventPayload: payload })}
      overview={members === undefined ? undefined : overviewWith(members)}
      placement={placement}
      shared={shared}
      actions={null}
    />,
  );
const header = (view: RunView, options?: Parameters<typeof heading>[1]) =>
  heading(detail(view), options);
/** Returns the visible text of the run title. */
const titleText = (markup: string) =>
  /<h1[^>]*>(.*?)<\/h1>/su.exec(markup)?.[1]?.replaceAll(/<[^>]+>/gu, "") ?? "";
const pullRequestPayload = {
  number: 33,
  title: "Board lanes",
  url: "https://github.com/basaltbytes/usine/pull/33",
  state: "OPEN",
};
const links = (markup: string, url: string) => markup.split(`href="${url}"`).length - 1;

describe("Run header", () => {
  it("links the issue and the pull request the Run opened to GitHub in new tabs", () => {
    const markup = header(run({ pullRequestUrl: "https://github.com/basaltbytes/usine/pull/101" }));
    assert.include(markup, 'title="Issue #33"');
    assert.include(markup, 'href="https://github.com/basaltbytes/usine/issues/33"');
    assert.include(markup, 'title="Pull request #101"');
    assert.include(markup, 'href="https://github.com/basaltbytes/usine/pull/101"');
    assert.lengthOf(markup.match(/target="_blank"/gu) ?? [], 2);
  });

  it("names the state, Loop, and Agent, and shows no pull request if the Run opened none", () => {
    const failed = run({
      state: "Failed",
      attempts: [
        attempt(new FailedAttemptView({ failure: new AgentFailureView({ message: "Blocked" }) })),
        new AttemptView({
          ...attempt(new FailedAttemptView({ failure: new AgentFailureView({ message: "x" }) })),
          id: AttemptId.make("attempt-2"),
          number: AttemptNumber.make(2),
        }),
      ],
    });
    const markup = header(failed);
    assert.notInclude(markup, "No pull request");
    assert.notInclude(markup, "/pull/");
    assert.include(markup, "Failed after 2 attempts");
    assert.include(markup, "start-dev");
    assert.include(markup, "developer");
    assert.lengthOf(markup.match(/target="_blank"/gu) ?? [], 1);
  });

  it("marks each item with its GitHub state from the Board", () => {
    const markup = header(
      run({ pullRequestUrl: "https://github.com/basaltbytes/usine/pull/101" }),
      {
        members: [member(33, "issue", "issue-closed"), member(101, "pr", "pr-merged")],
      },
    );
    assert.include(markup, 'title="Issue #33, closed"');
    assert.include(markup, 'title="Pull request #101, merged"');
    assert.notInclude(markup, "Issue closed");
  });

  it("marks the Item with its settled state while the Board doesn't show its Task", () => {
    const failed = run({
      state: "Failed",
      attempts: [
        attempt(new FailedAttemptView({ failure: new AgentFailureView({ message: "x" }) })),
      ],
    });
    const settled = (state: SettledItemState, payload = detail(failed).eventPayload) =>
      heading(new RunDetailView({ ...detail(failed), settledItemState: state }), { payload });
    assert.include(settled("issue-closed"), 'title="Issue #33, closed"');
    assert.include(settled("pr-closed", pullRequestPayload), 'title="Pull request #33, closed"');
    assert.include(settled("pr-merged", pullRequestPayload), 'title="Pull request #33, merged"');
    assert.include(header(failed), 'title="Issue #33"');
  });

  it("names a pull request Run's Task after its issue, inline in the title, with the pull request in the facts", () => {
    const markup = header(run(), {
      payload: pullRequestPayload,
      shared: true,
      members: [
        member(30, "issue", "issue-open", "Write the docs"),
        member(33, "pr", "pr-open", "Docs for the board"),
      ],
    });
    assert.match(
      markup,
      /<h1[^>]*style="view-transition-name:run-title"><a [^>]*title="Issue #30, open"/u,
    );
    assert.strictEqual(titleText(markup), "#30 Write the docs");
    assert.include(markup, 'title="Pull request #33, open"');
    assert.strictEqual(links(markup, "https://github.com/basaltbytes/usine/pull/33"), 1);
  });

  it("names a Task with no issue after its pull request, inline in the title", () => {
    const markup = header(run({ pullRequestUrl: "https://github.com/basaltbytes/usine/pull/33" }), {
      payload: pullRequestPayload,
      members: [member(33, "pr", "pr-closed", "Bump the npm group")],
    });
    assert.strictEqual(titleText(markup), "#33 Bump the npm group");
    assert.include(markup, 'title="Pull request #33, closed"');
    assert.strictEqual(links(markup, "https://github.com/basaltbytes/usine/pull/33"), 1);
  });

  it("titles an issue Item from its Board card", () => {
    const markup = header(run(), { members: [member(33, "issue", "issue-open", "Lanes")] });
    assert.strictEqual(titleText(markup), "#33 Lanes");
    assert.strictEqual(links(markup, "https://github.com/basaltbytes/usine/issues/33"), 1);
  });

  it("says when the Loop is paused", () => {
    assert.include(header(run({ loopPaused: true })), "Loop paused");
    assert.notInclude(header(run()), "Loop paused");
  });

  it("titles the Run from the Board's Item, then from its Event", () => {
    assert.include(header(run()), "Board lanes");
    const view = run();
    const fromEvent = runItem(view, undefined, detail(view).eventPayload);
    assert.deepEqual(
      Option.flatMap(fromEvent, ({ title }) => title),
      Option.some("Board lanes"),
    );
    assert.include(
      eventPreview("start-dev", detail(view).eventPayload),
      "start-dev matched issue #33: open, labeled ready-for-agent",
    );
  });

  it("names the title and state for the drawer-to-page transition only where they are shared", () => {
    const shared = header(run(), { shared: true });
    assert.include(shared, "view-transition-name:run-title");
    assert.include(shared, "view-transition-name:run-state");
    assert.notInclude(header(run()), "view-transition-name");
  });

  it("names a schedule Run by its Loop, without an Item link", () => {
    const scheduled = run({ itemKey: ItemKey.make('["github","basaltbytes/usine"]') });
    const markup = header(scheduled);
    assert.notInclude(markup, "/issues/");
    assert.strictEqual(titleText(markup), "start-dev on basaltbytes/usine");
  });
});

describe("Run work facts", () => {
  const second = AttemptId.make("attempt-2");
  const twoAttempts = run({
    attempts: [
      attempt(new SucceededAttemptView()),
      new AttemptView({ ...attempt(null), id: second, number: AttemptNumber.make(2) }),
    ],
  });
  const childSession = (id: string, agent: string, harness: BrainSpec["harness"], model: string) =>
    new ChildSession({
      id: AgentSessionId.make(id),
      parentId: AgentSessionId.make("parent"),
      agent: AgentName.make(agent),
      brain: new BrainSpec({ harness, model: ModelId.make(model), effort: "high" }),
    });
  const parentSession = new ParentSession({
    id: AgentSessionId.make("parent"),
    agent: AgentName.make("developer"),
    brain: new BrainSpec({ harness: "pi", model: ModelId.make("openai/gpt-5.5"), effort: "high" }),
  });
  const cost = (usd: number, estimate: boolean) =>
    new UsageCostView({ usd: UsdAmount.make(usd), estimate });
  const usage = new RunUsageView({
    tokens: TokenCount.make(27_300),
    pools: [
      new PoolUsageView({
        pool: "apiKeys",
        tokens: TokenCount.make(1_500),
        cost: cost(0.75, false),
      }),
      new PoolUsageView({
        pool: "claudePlan",
        tokens: TokenCount.make(20_000),
        cost: cost(1.25, true),
      }),
      new PoolUsageView({
        pool: "chatgptPlan",
        tokens: TokenCount.make(5_800),
        cost: cost(0.4, true),
      }),
    ],
    sessions: [
      new SessionUsageView({
        attemptId,
        session: parentSession,
        pool: "apiKeys",
        tokens: TokenCount.make(1_500),
        cost: cost(0.75, false),
      }),
      new SessionUsageView({
        attemptId,
        session: childSession("claude", "developer", "claude", "claude-opus-4-7"),
        pool: "claudePlan",
        tokens: TokenCount.make(20_000),
        cost: cost(1.25, true),
      }),
      new SessionUsageView({
        attemptId: second,
        session: childSession("codex", "reviewer", "codex", "gpt-5.6-sol"),
        pool: "chatgptPlan",
        tokens: TokenCount.make(5_800),
        cost: cost(0.4, true),
      }),
    ],
  });
  const worked = (duration: Partial<ConstructorParameters<typeof RunDurationView>[0]> = {}) =>
    new RunDetailView({
      ...detail(twoAttempts),
      worker: WorkerName.make("usine-worker-1"),
      duration: new RunDurationView({
        endedMillis: 25 * 60_000,
        runningSince: null,
        unmeasured: 0,
        ...duration,
      }),
      usage,
    });
  const facts = (view: RunDetailView, showUsage: boolean) =>
    heading(view, { placement: showUsage ? "page" : "drawer" })
      .replaceAll(/<[^>]+>/gu, " ")
      .replaceAll(/\s+/gu, " ");

  it("names the newest Attempt's Worker, the Attempts' total time, and on the Run page their tokens", () => {
    const page = facts(worked(), true);
    assert.include(page, "usine-worker-1");
    assert.include(page, " 25 min ");
    assert.include(page, "27.3K tokens");
    const drawer = facts(worked(), false);
    assert.include(drawer, "usine-worker-1");
    assert.notInclude(drawer, "tokens");
  });

  it("counts a running Attempt into the total and says when earlier Attempts have no recorded end", () => {
    const running = facts(
      worked({ runningSince: new Date(Date.now() - 10 * 60_000).toISOString() }),
      false,
    );
    assert.include(running, " 35 min ");
    assert.include(facts(worked({ unmeasured: 1 }), false), " at least 25 min ");
  });

  it("says nothing about work before the first Attempt", () => {
    const waiting = facts(detail(run({ state: "Waiting", attempts: [] })), true);
    assert.include(waiting, "Waiting for approval");
    assert.notInclude(waiting, " min ");
    assert.notInclude(waiting, "tokens");
  });

  it("prices each pool, marks the plans' figures as estimates, and lists each session under its Attempt", () => {
    const markup = renderToStaticMarkup(
      <UsageBreakdown usage={usage} attempts={twoAttempts.attempts} />,
    );
    const text = markup.replaceAll(/<[^>]+>/gu, " ").replaceAll(/\s+/gu, " ");
    assert.include(text, "API keys 1,500 $0.75 Claude plan");
    assert.include(text, "Claude plan 20,000 $1.25 estimate");
    assert.include(text, "ChatGPT plan 5,800 $0.40 estimate");
    assert.include(
      text,
      "Attempt 1 Parent openai/gpt-5.5 1,500 $0.75 developer claude-opus-4-7 20,000 $1.25 estimate",
    );
    assert.include(text, "Attempt 2 reviewer gpt-5.6-sol 5,800 $0.40 estimate Tokens are");
  });
});

describe("provisioned machine", () => {
  const visible = (markup: string) =>
    markup
      .replaceAll(/<[^>]+>/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .replaceAll(" ,", ",");
  const failed = attempt(
    new FailedAttemptView({ failure: new AgentFailureView({ message: "No" }) }),
  );
  const outline = (view: RunView, machine: RunDetailView["machine"]) =>
    visible(
      renderToStaticMarkup(
        <Outline
          run={view}
          eventPreview="Issue #33"
          document={readerDocument(projectTranscript([], view.attempts), view.attempts, [])}
          selection={{ _tag: "Event" }}
          reading={null}
          composerSession={null}
          onSelect={() => {}}
          onCheckpoint={() => {}}
          errors={null}
          machine={machine}
        />,
      ),
    );

  it("shows the machine being created for a queued Run's next Attempt as its own step", () => {
    const queued = run({ state: "Queued", closedAt: null, attempts: [failed] });
    const machine = machineFixture({
      runId: queued.id,
      since: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    const steps = outline(queued, machine);
    assert.include(steps, "Creating machine Hetzner, for attempt 2");
    assert.isBelow(steps.indexOf("Attempt 1"), steps.indexOf("Creating machine"));
    const view = new RunDetailView({ ...detail(queued), machine });
    assert.include(visible(heading(view)), "Queued, creating a Hetzner machine");
    assert.include(
      renderToStaticMarkup(<RunSummary detail={view} />),
      "Creating a Hetzner machine, started 2m ago",
    );
  });

  it("names the provider ID of the running Attempt's machine beside its Worker", () => {
    const running = run({ state: "Running", closedAt: null, attempts: [attempt(null)] });
    const machine = machineFixture({
      runId: running.id,
      state: "ready",
      id: "52341896",
      attemptId,
    });
    const markup = heading(
      new RunDetailView({ ...detail(running), worker: WorkerName.make("hz-pool"), machine }),
    );
    assert.include(visible(markup), "hz-pool 52341896");
    assert.include(markup, 'title="Hetzner server 52341896"');
    assert.notInclude(outline(running, machine), "machine");
  });
});

describe("Attempt start", () => {
  const started = (
    number: number,
    start: AttemptView["start"],
    reattachedAt: string | null = null,
  ) =>
    new AttemptView({
      ...attempt(new FailedAttemptView({ failure: new AgentFailureView({ message: "No" }) })),
      id: AttemptId.make(`attempt-${number}`),
      number: AttemptNumber.make(number),
      start,
      reattachedAt,
    });
  const philippe = Option.some(OperatorLogin.make("Philippe"));
  const attempts = [
    started(1, new StartedByEvent(), "2026-09-01T12:10:00.000Z"),
    started(2, new StartedByInfraRetry()),
    started(3, new StartedAfterRestart()),
    started(4, new StartedByRetry({ operator: philippe })),
    started(5, new StartedByEditAndRetry({ operator: Option.none() })),
    started(6, null),
  ];
  const view = run({ state: "Failed", attempts });

  it("says beside each Attempt's time why it began, and when a restart reattached it", () => {
    const markup = renderToStaticMarkup(
      <Outline
        run={view}
        eventPreview="Issue #33"
        document={readerDocument(projectTranscript([], attempts), attempts, [])}
        selection={{ _tag: "Event" }}
        reading={null}
        composerSession={null}
        onSelect={() => {}}
        onCheckpoint={() => {}}
        errors={null}
      />,
    );
    const reasons = [
      ...markup.matchAll(
        /<span class="block truncate text-xs text-muted-foreground"[^>]*>([^<]+)</gu,
      ),
    ].map(([, reason]) => reason);
    assert.deepEqual(reasons, [
      "From the event",
      "Reattached after a restart",
      "Retried after an infrastructure failure",
      "Started again after a restart",
      "Retried by Philippe",
      "Edited and retried",
    ]);
  });
});

describe("salvage line", () => {
  it("names the pushed ref and short commit", () => {
    const markup = renderToStaticMarkup(
      <SalvageLine
        salvage={
          new SalvagePushed({
            ref: SalvageRef.make("usine/salvage/run/1"),
            commit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
          })
        }
      />,
    );
    assert.include(markup, "usine/salvage/run/1");
    assert.include(markup, "0123456");
    assert.notInclude(markup, "0123456789abcdef");
  });

  it("names the pushed ref and the checkout that keeps the files the push left out", () => {
    const markup = renderToStaticMarkup(
      <SalvageLine
        salvage={
          new SalvagePartlyPushed({
            ref: SalvageRef.make("usine/salvage/run/1"),
            commit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
            path: "/workers/local/attempts/run_execute_1",
            message:
              "The checkout has files larger than GitHub's 100 MiB limit, which the salvage can't push: dataset.csv (100.0 MiB)",
          })
        }
      />,
    );
    assert.include(markup, "usine/salvage/run/1");
    assert.include(markup, "0123456");
    assert.include(markup, "/workers/local/attempts/run_execute_1");
    assert.include(markup, "dataset.csv (100.0 MiB)");
  });

  it("shows where retained work lives, that startup retries it, and why the last try failed", () => {
    const markup = renderToStaticMarkup(
      <SalvageLine
        salvage={
          new SalvageRetained({
            path: "/workers/local/attempts/run_execute_1",
            commit: Option.none(),
            message: "git exited with code 128: remote: Repository not found.",
          })
        }
      />,
    );
    assert.include(markup, "/workers/local/attempts/run_execute_1");
    assert.include(markup, "retried at each startup");
    assert.include(markup, "remote: Repository not found.");
  });

  it("shows where rejected work lives, that startup doesn't retry it, and the remote's refusal", () => {
    const markup = renderToStaticMarkup(
      <SalvageLine
        salvage={
          new SalvageRejected({
            path: "/workers/local/attempts/run_execute_1",
            commit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
            message: "git exited with code 1: remote: error: GH001: Large files detected.",
          })
        }
      />,
    );
    assert.include(markup, "/workers/local/attempts/run_execute_1");
    assert.include(markup, "doesn&#x27;t retry it");
    assert.notInclude(markup, "retried at each startup");
    assert.include(markup, "GH001: Large files detected.");
  });

  it("says when no salvage branch exists", () => {
    assert.include(renderToStaticMarkup(<SalvageLine salvage={null} />), "No salvage branch");
  });
});

describe("drawer summary", () => {
  const summary = (view: RunView, transcript: ReadonlyArray<TranscriptEventView> = []) =>
    renderToStaticMarkup(<RunSummary detail={detail(view, transcript)} />);

  it("states what an open Run waits for", () => {
    assert.include(summary(run({ state: "Waiting", attempts: [] })), "Waiting for approval");
    assert.include(summary(run({ state: "Queued", attempts: [] })), "waiting for a free worker");
  });

  it("shows a failed Run's typed reason, message and salvage in one paragraph", () => {
    const markup = summary(
      run({
        state: "Failed",
        attempts: [
          attempt(
            new FailedAttemptView({
              failure: new AgentFailureView({ message: "The baseline gate is blocked." }),
            }),
            new SalvagePushed({
              ref: SalvageRef.make("usine/salvage/run-33/1"),
              commit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
            }),
          ),
        ],
      }),
    );
    assert.include(markup, "Agent failure");
    assert.include(markup, "The baseline gate is blocked.");
    assert.include(markup, "usine/salvage/run-33/1");
  });

  it("shows an Agent's question for a Run that waits on an answer", () => {
    const markup = summary(
      run({
        state: "Failed",
        attempts: [
          attempt(
            new FailedAttemptView({
              failure: new QuestionFailureView({ question: "Keep the old column?" }),
            }),
          ),
        ],
      }),
    );
    assert.include(markup, "Question from the agent");
    assert.include(markup, "Keep the old column?");
  });

  it("shows a succeeded Run's result and a canceled Run's salvage", () => {
    const succeeded = summary(run());
    assert.include(succeeded, "Succeeded");
    assert.include(succeeded, "Opened the pull request.");
    const canceled = summary(
      run({ state: "Canceled", attempts: [attempt(new CanceledAttemptView())] }),
    );
    assert.include(canceled, "Canceled");
    assert.include(canceled, "No salvage branch");
  });

  it("shows a running Run's current activity and latest message, without the conversation", () => {
    const parent = new ParentSession({
      id: AgentSessionId.make("parent"),
      agent: AgentName.make("developer"),
      brain,
    });
    const child = new ChildSession({
      id: AgentSessionId.make("child"),
      parentId: parent.id,
      agent: AgentName.make("reviewer"),
      brain,
    });
    const event = (sequence: number, payload: TranscriptEventView["payload"]) =>
      new TranscriptEventView({
        sequence: TranscriptSequence.make(sequence),
        attemptId,
        receivedAt: `2026-09-01T12:0${sequence}:00.000Z`,
        direction: "outbound",
        payload,
      });
    const markup = summary(run({ state: "Running", attempts: [attempt(null)], canCancel: true }), [
      event(
        1,
        new SessionEvent({ event: new TextOutput({ session: child, text: "First step." }) }),
      ),
      event(
        2,
        new SessionEvent({
          event: new TextOutput({ session: child, text: "Running the **tests** now." }),
        }),
      ),
      event(
        3,
        new SessionEvent({
          event: new ToolStarted({
            session: child,
            callId: "call",
            tool: "bash",
            input: { command: "pnpm test" },
          }),
        }),
      ),
    ]);
    assert.include(markup, "Running command");
    assert.include(markup, "pnpm test");
    assert.include(markup, "Running the tests now.");
    assert.notInclude(markup, "First step.");
    assert.notInclude(markup, "Run conversation");
  });

  it("warns while a running Run's Worker or a child's provider does not answer", () => {
    const child = new ChildSession({
      id: AgentSessionId.make("child"),
      parentId: AgentSessionId.make("parent"),
      agent: AgentName.make("reviewer"),
      brain,
    });
    const lastAnsweredAt = "2026-09-01T12:01:00.000Z";
    const markup = summary(run({ state: "Running", attempts: [attempt(null)], canCancel: true }), [
      new TranscriptEventView({
        sequence: TranscriptSequence.make(1),
        attemptId,
        receivedAt: "2026-09-01T12:02:00.000Z",
        direction: "outbound",
        payload: new WorkerUnresponsive({
          worker: WorkerName.make("usine-worker-1"),
          lastAnsweredAt: DateTime.makeUnsafe(lastAnsweredAt),
          reason: "No answer within 45 seconds",
        }),
      }),
      new TranscriptEventView({
        sequence: TranscriptSequence.make(2),
        attemptId,
        receivedAt: "2026-09-01T12:03:00.000Z",
        direction: "outbound",
        payload: new SessionEvent({
          event: new ProviderRetrying({
            session: child,
            message: "Reconnecting... waiting for network",
            retries: ProviderRetries.make(4),
          }),
        }),
      }),
    ]);
    assert.include(markup, `usine-worker-1 silent since ${clockLabel(lastAnsweredAt)}`);
    assert.include(markup, "reviewer: provider unreachable, 4 retries since");
    assert.include(markup, "Reconnecting... waiting for network");
  });
});

describe("Run approval", () => {
  const approvedAt = "2026-09-01T11:59:30.000Z";
  const approved = (source: ApprovalView["source"]) =>
    run({ approval: new ApprovalView({ approvedAt, source }) });
  const philippe = Option.some(OperatorLogin.make("Philippe"));
  const fromUi = approved(new ApprovalSource({ channel: "ui", approver: philippe }));
  const fromAsk = approved(new ApprovalSource({ channel: "github-ask", approver: philippe }));
  // Approved before usine recorded the approver.
  const unrecorded = approved(null);
  const eventDocument = (view: RunView) =>
    renderToStaticMarkup(
      <WithRouter>
        <EventDocument detail={detail(view)} />
      </WithRouter>,
    );
  const outline = (view: RunView) =>
    renderToStaticMarkup(
      <Outline
        run={view}
        eventPreview={eventPreview(view.loop, detail(view).eventPayload)}
        document={readerDocument(projectTranscript([], view.attempts), view.attempts, [])}
        selection={{ _tag: "Event" }}
        reading={null}
        composerSession={null}
        onSelect={() => {}}
        onCheckpoint={() => {}}
        errors={null}
      />,
    );
  const text = (markup: string) => markup.replaceAll(/<[^>]+>/gu, "");

  it("names the approver, time, and channel in the Event entry and the Event document", () => {
    const time = dayTimeLabel(approvedAt);
    for (const render of [eventDocument, outline]) {
      assert.include(text(render(fromUi)), `Approved by Philippe · ${time} · from the UI`);
      assert.include(text(render(fromAsk)), `Approved by Philippe · ${time} · from GitHub`);
      assert.include(render(fromAsk), `dateTime="${approvedAt}"`);
    }
  });

  it("says only Approved and when for an approval recorded before its source was", () => {
    for (const render of [eventDocument, outline]) {
      const markup = text(render(unrecorded));
      assert.include(markup, `Approved · ${dayTimeLabel(approvedAt)}`);
      assert.notInclude(markup, "Approved by");
      assert.notInclude(markup, "from the");
    }
  });

  it("says nothing about approval for a Run that had none", () => {
    for (const render of [eventDocument, outline]) assert.notInclude(render(run()), "Approved");
  });

  it("names who ran an earlier Run again, when, and which Run, beside the approval", () => {
    const openedAt = "2026-09-01T11:59:00.000Z";
    const from = RunId.make("4f1c9e2a7b3d4c5e");
    const ranAgain = (requestedBy: RunAgain["requestedBy"]) =>
      run({ runAgain: new RunAgain({ from, requestedBy }), openedAt });
    const time = dayTimeLabel(openedAt);
    for (const render of [eventDocument, outline]) {
      const named = text(render(ranAgain(philippe)));
      assert.include(named, `Run again by Philippe · ${time} · from run 4f1c9e2a`);
      assert.include(render(ranAgain(philippe)), `dateTime="${openedAt}"`);
      assert.include(text(render(ranAgain(Option.none()))), `Run again · ${time} · from run`);
      assert.include(
        text(render(new RunView({ ...ranAgain(philippe), approval: fromUi.approval }))),
        `Approved by Philippe · ${dayTimeLabel(approvedAt)} · from the UI`,
      );
      assert.notInclude(render(run()), "Run again");
    }
    // The Event document links to the earlier Run's page; the outline entry is a button instead.
    assert.include(
      eventDocument(ranAgain(philippe)),
      `href="/projects/basaltbytes/usine/runs/${from}"`,
    );
    assert.notInclude(outline(ranAgain(philippe)), `/runs/${from}`);
  });
});
