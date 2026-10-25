import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  AgentFailureView,
  AttemptView,
  BlockedFailureView,
  FailedAttemptView,
  LocalWorkerAccess,
  QuestionFailureView,
  RunView,
  SucceededAttemptView,
} from "@usine/orchestrator/operator";
import { assert, describe, it } from "vitest";
import { actionLabel, actionPlan, type RunAction } from "../src/run-intervention/action-plan.ts";

const attemptId = AttemptId.make("attempt-1");
const attempt = (outcome: AttemptView["outcome"]) =>
  new AttemptView({
    id: attemptId,
    number: AttemptNumber.make(1),
    worker: WorkerName.make("local"),
    workerAccess: new LocalWorkerAccess(),
    brain: new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "high" }),
    task: AttemptTask.make("Fix issue 33."),
    agent: AgentName.make("developer"),
    operatorIntervened: false,
    startedAt: "2026-09-01T12:00:00.000Z",
    outcome,
    endedAt: outcome === null ? null : "2026-09-01T12:25:00.000Z",
    salvage: null,
  });
const run = (fields: Partial<ConstructorParameters<typeof RunView>[0]> = {}) =>
  new RunView({
    id: RunId.make("run-33"),
    itemKey: ItemKey.make('["github","basaltbytes/usine",33]'),
    loop: LoopName.make("start-dev"),
    repository: RepositoryName.make("basaltbytes/usine"),
    agent: AgentName.make("developer"),
    state: "Running",
    loopPaused: false,
    openedAt: "2026-09-01T11:59:00.000Z",
    closedAt: null,
    task: "Fix issue 33.",
    attempts: [],
    approval: null,
    runAgain: null,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: false,
    canRetry: false,
    canResolveFailure: false,
    canCancel: false,
    canRunAgain: false,
    ...fields,
  });
const failed = (failure: FailedAttemptView["failure"], canResolveFailure = true) =>
  run({
    state: "Failed",
    attempts: [attempt(new FailedAttemptView({ failure }))],
    canRetry: true,
    canResolveFailure,
  });

/** Returns the plan as button labels, so a case reads like the header it renders. */
const labels = (view: RunView) => {
  const plan = actionPlan(view);
  const label = (action: RunAction | null) => (action === null ? null : actionLabel(action));
  return {
    primary: label(plan.primary),
    secondary: label(plan.secondary),
    more: plan.more.map(actionLabel),
  };
};

describe("contextual run actions", () => {
  it("leads with Approve on a waiting run and keeps Cancel run in the menu", () => {
    assert.deepStrictEqual(labels(run({ state: "Waiting", canApprove: true, canCancel: true })), {
      primary: "Approve",
      secondary: null,
      more: ["Cancel run"],
    });
  });

  it("offers only Cancel run as the secondary action on an open run", () => {
    for (const state of ["Pending", "Queued", "Running"] as const)
      assert.deepStrictEqual(labels(run({ state, canCancel: true })), {
        primary: null,
        secondary: "Cancel run",
        more: [],
      });
  });

  it("leads with Mark answered when the agent asked a question", () => {
    const view = failed(new QuestionFailureView({ question: "Merge or rebase?" }));
    assert.deepStrictEqual(labels(view), {
      primary: "Mark answered",
      secondary: "Edit and retry",
      more: ["Retry"],
    });
    assert.deepStrictEqual(actionPlan(view).primary, {
      _tag: "Resolve",
      attemptId,
      question: true,
    });
  });

  it("leads with Mark resolved when the agent was blocked", () => {
    assert.deepStrictEqual(labels(failed(new BlockedFailureView({ message: "Gate is red." }))), {
      primary: "Mark resolved",
      secondary: "Edit and retry",
      more: ["Retry"],
    });
  });

  it("leads with Retry on another failure and keeps Mark resolved in the menu", () => {
    assert.deepStrictEqual(labels(failed(new AgentFailureView({ message: "Tests failed." }))), {
      primary: "Retry",
      secondary: "Edit and retry",
      more: ["Mark resolved"],
    });
  });

  it("leads with Retry on a question that no longer needs an answer", () => {
    assert.deepStrictEqual(
      labels(failed(new QuestionFailureView({ question: "Merge or rebase?" }), false)),
      { primary: "Retry", secondary: "Edit and retry", more: [] },
    );
  });

  it("leads with Mark resolved on a failure that can't be retried", () => {
    const view = new RunView({
      ...failed(new AgentFailureView({ message: "Tests failed." })),
      canRetry: false,
    });
    assert.deepStrictEqual(labels(view), { primary: "Mark resolved", secondary: null, more: [] });
  });

  it("offers Run again as the secondary action on a closed run", () => {
    for (const state of ["Succeeded", "Canceled"] as const)
      assert.deepStrictEqual(
        labels(run({ state, attempts: [attempt(new SucceededAttemptView())], canRunAgain: true })),
        { primary: null, secondary: "Run again", more: ["Edit and run again"] },
      );
  });

  it("puts every other allowed action in the menu", () => {
    const view = new RunView({
      ...failed(new AgentFailureView({ message: "Tests failed." })),
      canCancel: true,
    });
    assert.deepStrictEqual(labels(view), {
      primary: "Retry",
      secondary: "Edit and retry",
      more: ["Mark resolved", "Cancel run"],
    });
  });

  it("plans nothing when no action is allowed", () => {
    assert.deepStrictEqual(labels(run({ state: "Succeeded" })), {
      primary: null,
      secondary: null,
      more: [],
    });
  });
});
