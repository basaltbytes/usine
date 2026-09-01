import { Agent, Attempt, Item, Loop, Repository, Run, Worker } from "@usine/core";
import {
  AgentFailureView,
  AttemptView,
  BoardItemView,
  FailedAttemptView,
  RunView,
  SucceededAttemptView,
} from "@usine/orchestrator";
import { assert, describe, it } from "vitest";
import { itemFailure } from "../src/board.tsx";

const brain = new Agent.BrainSpec({
  harness: "codex",
  model: Agent.ModelId.make("gpt-5.6-sol"),
  effort: "high",
});

const attempt = (number: number, message: string | null) =>
  new AttemptView({
    id: Attempt.AttemptId.make(`attempt-${number}`),
    number: Attempt.AttemptNumber.make(number),
    worker: Worker.Name.make("local"),
    brain,
    startedAt: `2026-09-01T12:00:0${number}.000Z`,
    outcome:
      message === null
        ? new SucceededAttemptView()
        : new FailedAttemptView({ failure: new AgentFailureView({ message }) }),
  });

const itemWithRun = (state: "Failed" | "Succeeded", attempts: ReadonlyArray<AttemptView>) => {
  const itemKey = Item.ItemKey.make("github:basaltbytes/usine:33");
  const run = new RunView({
    id: Run.RunId.make("run-33"),
    itemKey,
    loop: Loop.LoopName.make("review"),
    repository: Repository.Name.make("basaltbytes/usine"),
    agent: Agent.Name.make("developer"),
    state,
    loopPaused: false,
    openedAt: "2026-09-01T12:00:00.000Z",
    task: "Review issue 33.",
    attempts,
    resultMessage: null,
    pullRequestUrl: null,
    canApprove: false,
    canRetry: state === "Failed",
    canCancel: false,
  });
  return new BoardItemView({
    itemKey,
    kind: "issue",
    number: Item.Number.make(33),
    title: "Board lanes",
    url: "https://github.com/basaltbytes/usine/issues/33",
    state: "issue-open",
    labels: [],
    runs: [run],
    run,
    needsYou: state === "Failed",
  });
};

describe("Board Run failure copy", () => {
  it("hides a failed Attempt after its Run recovers", () => {
    assert.strictEqual(
      itemFailure(itemWithRun("Succeeded", [attempt(1, "obsolete failure"), attempt(2, null)])),
      null,
    );
  });

  it("shows the latest failed Attempt for a currently Failed Run", () => {
    assert.strictEqual(
      itemFailure(
        itemWithRun("Failed", [attempt(1, "old failure"), attempt(2, "current failure")]),
      ),
      "current failure",
    );
  });
});
