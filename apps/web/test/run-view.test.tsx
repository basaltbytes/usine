import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  ProviderRetries,
  ProviderRetrying,
  TextOutput,
  ToolStarted,
} from "@usine/core/agent/session";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { SessionEvent, WorkerUnresponsive } from "@usine/core/attempt/channel";
import { SalvagePushed, SalvageRef, SalvageRetained } from "@usine/core/attempt/salvage";
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
  AttemptView,
  CanceledAttemptView,
  FailedAttemptView,
  QuestionFailureView,
  RunDetailView,
  RunView,
  SucceededAttemptView,
  TranscriptEventView,
} from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { DateTime, Option, Schema } from "effect";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { clockLabel, dayTimeLabel } from "../src/operator-copy.ts";
import { RunSummary } from "../src/run-drawer.tsx";
import { EventDocument } from "../src/run-page/documents.tsx";
import { RunFacts, RunTitle } from "../src/run-page/header.tsx";
import { eventPreview, runItem } from "../src/run-page/item.ts";
import { Outline } from "../src/run-page/outline.tsx";
import { readerDocument } from "../src/run-transcript/document/model.ts";
import { projectTranscript } from "../src/run-transcript/model.ts";
import { SalvageLine } from "../src/run-transcript/outcome.tsx";

const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(33)]);
const brain = new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "high" });
const attemptId = AttemptId.make("attempt-1");
const attempt = (outcome: AttemptView["outcome"], salvage: AttemptView["salvage"] = null) =>
  new AttemptView({
    id: attemptId,
    number: AttemptNumber.make(1),
    worker: WorkerName.make("local"),
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
    id: RunId.make("run-33"),
    itemKey,
    loop: LoopName.make("start-dev"),
    repository,
    agent: AgentName.make("developer"),
    state: "Succeeded",
    loopPaused: false,
    openedAt: "2026-09-01T11:59:00.000Z",
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
const header = (
  view: RunView,
  payload: Schema.Json = detail(view).eventPayload,
  shared = false,
) => {
  const item = runItem(view, undefined, payload);
  return renderToStaticMarkup(
    <>
      <RunTitle
        run={view}
        item={item}
        shared={shared}
        heading={(title: ReactNode) => <h1>{title}</h1>}
      />
      <RunFacts run={view} item={item} shared={shared} />
    </>,
  );
};

describe("Run header", () => {
  it("links the Item and produced PR to GitHub in new tabs", () => {
    const markup = header(run({ pullRequestUrl: "https://github.com/basaltbytes/usine/pull/101" }));
    assert.include(markup, ">#33<");
    assert.include(markup, 'href="https://github.com/basaltbytes/usine/issues/33"');
    assert.include(markup, 'href="https://github.com/basaltbytes/usine/pull/101"');
    assert.include(markup, "#101");
    assert.lengthOf(markup.match(/target="_blank"/gu) ?? [], 2);
  });

  it("says when the Run produced no pull request and names its state, Loop and Agent", () => {
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
    assert.include(markup, "No pull request");
    assert.notInclude(markup, "/pull/");
    assert.include(markup, "Failed after 2 Attempts");
    assert.include(markup, "start-dev");
    assert.include(markup, "developer");
    assert.lengthOf(markup.match(/target="_blank"/gu) ?? [], 1);
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
      "start-dev matched issue #33: open, labelled ready-for-agent",
    );
  });

  it("shows the Item as the Run's pull request when the Item is one and the Run produced none", () => {
    const markup = header(run(), {
      number: 33,
      title: "Board lanes",
      url: "https://github.com/basaltbytes/usine/pull/33",
      state: "OPEN",
    });
    assert.notInclude(markup, "No pull request");
    assert.lengthOf(
      markup.match(/href="https:\/\/github.com\/basaltbytes\/usine\/pull\/33"/gu) ?? [],
      2,
    );
    assert.include(markup, "#33</span>");
  });

  it("names the title and state for the drawer-to-page transition only where they are shared", () => {
    const shared = header(run(), detail(run()).eventPayload, true);
    assert.include(shared, "view-transition-name:run-title");
    assert.include(shared, "view-transition-name:run-state");
    assert.notInclude(header(run()), "view-transition-name");
  });

  it("names a schedule Run by its Loop, without an Item link", () => {
    const scheduled = run({ itemKey: ItemKey.make('["github","basaltbytes/usine"]') });
    const markup = header(scheduled);
    assert.notInclude(markup, "/issues/");
    assert.include(markup, "start-dev on basaltbytes/usine");
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
    assert.include(markup, "every startup");
    assert.include(markup, "remote: Repository not found.");
  });

  it("says when no salvage branch exists", () => {
    assert.include(renderToStaticMarkup(<SalvageLine salvage={null} />), "No salvage branch.");
  });
});

describe("drawer summary", () => {
  const summary = (view: RunView, transcript: ReadonlyArray<TranscriptEventView> = []) =>
    renderToStaticMarkup(<RunSummary detail={detail(view, transcript)} />);

  it("states what an open Run waits for", () => {
    assert.include(summary(run({ state: "Waiting", attempts: [] })), "Waits for your approval");
    assert.include(summary(run({ state: "Queued", attempts: [] })), "waiting for a free Worker");
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
    assert.include(markup, "Question for you");
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
    assert.include(canceled, "No salvage branch.");
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
    assert.include(
      markup,
      `Worker usine-worker-1 has not answered since ${clockLabel(lastAnsweredAt)}`,
    );
    assert.include(markup, "reviewer cannot reach its provider, 4 retries since");
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
  // Approved before usine recorded who approved.
  const unrecorded = approved(null);
  const eventDocument = (view: RunView) =>
    renderToStaticMarkup(<EventDocument detail={detail(view)} />);
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
      assert.include(text(render(fromAsk)), `Approved by Philippe · ${time} · from the GitHub Ask`);
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
      assert.include(named, `Run again by Philippe · ${time} · from Run 4f1c9e2a`);
      assert.include(render(ranAgain(philippe)), `dateTime="${openedAt}"`);
      assert.include(text(render(ranAgain(Option.none()))), `Run again · ${time} · from Run`);
      assert.include(
        text(render(new RunView({ ...ranAgain(philippe), approval: fromUi.approval }))),
        `Approved by Philippe · ${dayTimeLabel(approvedAt)} · from the UI`,
      );
      assert.notInclude(render(run()), "Run again");
    }
  });
});
