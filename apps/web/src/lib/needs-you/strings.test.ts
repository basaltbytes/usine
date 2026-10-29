import { ProjectView } from "@usine/orchestrator/operator";
import { ProjectId } from "@usine/core/project";
import { boardOverview } from "~/lib/projects/fixture";
import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import {
  BlockedFailureView,
  ConfigFileNeed,
  PoolLimitNeed,
  QuestionFailureView,
  RunFailureNeed,
  UnconfiguredWorkerNeed,
  UnresponsiveWorkerNeed,
  UnconfirmedStopNeed,
} from "@usine/orchestrator/operator";
import { DateTime, Option, Schema } from "effect";
import { assert, describe, it } from "vitest";
import { needsYouByProject } from "~/lib/overview";
import { needCopy } from "~/lib/needs-you/strings";

describe("operator question copy in Needs attention", () => {
  it("names the asking Loop and shows the Agent's question", () => {
    const copy = needCopy(
      new RunFailureNeed({
        id: "run-failure:asked",
        repository: RepositoryName.make("basaltbytes/usine"),
        runId: RunId.make("asked"),
        loop: LoopName.make("act-on-findings"),
        failure: new QuestionFailureView({ question: "HTTP CONNECT or SOCKS for egress?" }),
      }),
    );
    assert.strictEqual(copy.title, "Question from act-on-findings");
    assert.strictEqual(copy.detail, "HTTP CONNECT or SOCKS for egress?");
    assert.strictEqual(copy.runId, "asked");
  });
});

describe("blocker copy in Needs attention", () => {
  it("names the blocked Loop and shows the Agent's blocker", () => {
    const copy = needCopy(
      new RunFailureNeed({
        id: "run-failure:blocked",
        repository: RepositoryName.make("basaltbytes/usine"),
        runId: RunId.make("blocked"),
        loop: LoopName.make("start-dev"),
        failure: new BlockedFailureView({
          message: "The baseline gate fails on main before any change.",
        }),
      }),
    );
    assert.strictEqual(copy.title, "start-dev: blocked");
    assert.strictEqual(copy.detail, "The baseline gate fails on main before any change.");
    assert.strictEqual(copy.runId, "blocked");
  });
});

describe("config file copy in Needs attention", () => {
  const need = (kind: "loop" | "agent", file: string, message: string) =>
    Schema.decodeUnknownSync(ConfigFileNeed)({
      _tag: "ConfigFileNeed",
      id: `config-file:${file}`,
      kind,
      error: { _tag: "ConfigFileError", file, stage: "reference", message },
    });

  it("names a quarantined Loop's file and reason", () => {
    const copy = needCopy(
      need(
        "loop",
        "loops/ghost.md",
        'Unknown agent "ghost": agents/ghost.md is missing or invalid. Fix the agent file, or set agent to an existing agent.',
      ),
    );
    assert.strictEqual(copy.title, "Loop file not loaded");
    assert.include(
      copy.detail,
      'loops/ghost.md: Unknown agent "ghost": agents/ghost.md is missing',
    );
    assert.include(copy.detail, "reload the configuration");
    assert.isNull(copy.runId);
  });

  it("names an invalid Agent file", () => {
    const copy = needCopy(need("agent", "agents/intern.md", "Expected a known harness"));
    assert.strictEqual(copy.title, "Agent file not loaded");
    assert.include(copy.detail, "agents/intern.md: Expected a known harness");
  });
});

describe("unconfigured Worker copy in Needs attention", () => {
  const need = (attempts: number, running = 0) =>
    new UnconfiguredWorkerNeed({
      id: "unconfigured-worker:local",
      worker: WorkerName.make("local"),
      attempts,
      running,
    });

  it("names the Worker, counts its Attempts, and gives both ways out", () => {
    const copy = needCopy(need(114));
    assert.strictEqual(copy.title, "Worker not configured");
    assert.include(copy.detail, "local is not in usine.yaml");
    assert.include(copy.detail, "114 recorded attempts");
    assert.include(copy.detail, "Add the worker back");
    assert.include(copy.detail, "discard the leftovers");
    assert.include(needCopy(need(1)).detail, "1 recorded attempt on it");
  });

  it("says how many Attempts still run on a removed Worker", () => {
    assert.strictEqual(
      needCopy(need(3, 2)).detail,
      "local is not in usine.yaml. 2 attempts still running on it. Discard the leftovers after they end",
    );
    assert.include(needCopy(need(3, 1)).detail, "1 attempt still running on it");
  });
});

describe("unconfirmed stop copy in Needs attention", () => {
  it("names the Loop, the Attempt, and the Worker it still ends on, and links the Run", () => {
    const copy = needCopy(
      new UnconfirmedStopNeed({
        id: "unconfirmed-stop:attempt",
        repository: RepositoryName.make("basaltbytes/usine"),
        runId: RunId.make("canceled"),
        loop: LoopName.make("develop"),
        attemptNumber: AttemptNumber.make(2),
        worker: WorkerName.make("local"),
      }),
    );
    assert.deepStrictEqual(copy, {
      title: "develop: parent task not stopped",
      detail:
        "Attempt 2 still ending on local, using one slot. No new attempt on this item until it stops. Stop retried every few minutes",
      repository: RepositoryName.make("basaltbytes/usine"),
      runId: RunId.make("canceled"),
    });
  });
});

it("counts a worker alert once for each affected project", () => {
  const repositories = [
    RepositoryName.make("test/one"),
    RepositoryName.make("test/one"),
    RepositoryName.make("test/two"),
  ];
  const need = new UnresponsiveWorkerNeed({
    id: "worker:remote",
    worker: WorkerName.make("remote"),
    lastAnsweredAt: "2026-10-28T14:35:00Z",
    attempts: repositories.map((repository, index) => ({
      repository,
      runId: RunId.make(`run-${index}`),
      loop: LoopName.make("implement"),
      attemptId: AttemptId.make(`attempt-${index}`),
      attemptNumber: AttemptNumber.make(1),
    })),
  });
  const projects = boardOverview().projects.map(
    (project) =>
      new ProjectView({
        ...project,
        id: ProjectId.make("combined"),
        repository: RepositoryName.make("test/one"),
        repositories: [RepositoryName.make("test/one"), RepositoryName.make("test/two")],
      }),
  );
  assert.deepStrictEqual([...needsYouByProject([need], projects)], [["combined", 1]]);
  assert.include(needCopy(need).detail, "3 attempts are still running");
});

it("identifies an unrecorded pool login without assigning its warning to a project", () => {
  const need = new PoolLimitNeed({
    id: "pool-limit:chatgptPlan:secondary",
    pool: "chatgptPlan",
    login: Option.none(),
    window: "secondary",
    usedPercent: 80,
    resetsAt: DateTime.makeUnsafe("2026-10-29T15:00:00Z"),
  });
  assert.include(needCopy(need).detail, "Login unavailable");
  assert.deepStrictEqual([...needsYouByProject([need], [])], []);
});
