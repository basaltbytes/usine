import { ProjectView } from "@usine/orchestrator/operator";
import { ProjectId } from "@usine/core/project";
import { boardOverview } from "~/lib/projects/fixture";
import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import {
  GatewayCredentialHolder,
  SshDestination,
  WorkerCredentialHolder,
  WorkerName,
} from "@usine/core/worker";
import {
  PoolLimitNeed,
  ProviderCapacityNeed,
  QuestionFailureView,
  RunFailureNeed,
  UnconfiguredWorkerNeed,
  UnresponsiveWorkerNeed,
  UnconfirmedStopNeed,
} from "@usine/orchestrator/operator";
import { DateTime, Option } from "effect";
import { assert, describe, it } from "vitest";
import { needsYouByProject } from "~/lib/overview";
import { CiFixRun } from "@usine/engine/run-reader";
import { CapacityGroup } from "@usine/engine/engine";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { fixRunStatus, needCopy } from "~/lib/needs-you/strings";

describe("operator question copy in Needs attention", () => {
  it("names the asking Loop and shows the Agent's question", () => {
    const copy = needCopy(
      RunFailureNeed.make({
        id: "run-failure:asked",
        repository: RepositoryName.make("basaltbytes/usine"),
        runId: RunId.make("asked"),
        loop: LoopName.make("act-on-findings"),
        failure: QuestionFailureView.make({ question: "HTTP CONNECT or SOCKS for egress?" }),
      }),
    );
    assert.strictEqual(copy.title, "Question from act-on-findings");
    assert.strictEqual(copy.detail, "HTTP CONNECT or SOCKS for egress?");
    assert.strictEqual(copy.runId, "asked");
  });
});

describe("unconfigured Worker copy in Needs attention", () => {
  const need = (attempts: number) =>
    UnconfiguredWorkerNeed.make({
      id: "unconfigured-worker:local",
      worker: WorkerName.make("local"),
      attempts,
      running: 0,
    });

  it("names the Worker, counts its Attempts, and gives both ways out", () => {
    const copy = needCopy(need(114));
    assert.strictEqual(copy.title, "Worker not configured");
    assert.include(copy.detail, "local is not in Configuration > Workers");
    assert.include(copy.detail, "114 recorded attempts");
    assert.include(copy.detail, "Add the worker back");
    assert.include(copy.detail, "discard the leftovers");
    assert.include(needCopy(need(1)).detail, "1 recorded attempt on it");
  });
});

describe("unconfirmed stop copy in Needs attention", () => {
  it("names the Loop, the Attempt, and the Worker it still ends on, and links the Run", () => {
    const copy = needCopy(
      UnconfirmedStopNeed.make({
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
  const need = UnresponsiveWorkerNeed.make({
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
  const projects = boardOverview().projects.map((project) =>
    ProjectView.make({
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
  const need = PoolLimitNeed.make({
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

it("words a failed run's CI fix link by the fix run's state", () => {
  const fix = (state: CiFixRun["state"]) =>
    fixRunStatus(CiFixRun.make({ runId: RunId.make("1a2b3c4d5e6f"), state }));
  assert.strictEqual(fix("AwaitingCi"), "fix run 1a2b3c4d continues the work");
  assert.strictEqual(fix("Succeeded"), "fix run 1a2b3c4d finished the work");
  assert.strictEqual(fix("HandedOff"), "fix run 1a2b3c4d handed the work to another fix run");
  assert.strictEqual(fix("Failed"), "fix run 1a2b3c4d failed too");
});

it("shows a capacity group at capacity once, with its next try and waiting runs, outside any project", () => {
  const group = CapacityGroup.make({
    harness: Harness.make("claude"),
    model: ModelId.make("claude-sonnet-4-6"),
    holder: WorkerCredentialHolder.make({ worker: WorkerName.make("local") }),
  });
  const need = ProviderCapacityNeed.make({
    id: "provider-capacity:local",
    group,
    message: "This request would exceed your account's rate limit.",
    since: "2026-11-13T23:44:00.000Z",
    nextTryAt: "2026-11-14T00:44:00.000Z",
    waitingRuns: 4,
  });
  const copy = needCopy(need);
  assert.include(copy.title, "claude claude-sonnet-4-6 on local: at capacity since");
  assert.include(copy.detail, "4 runs wait without failing");
  assert.include(copy.detail, "exceed your account's rate limit");
  assert.deepStrictEqual([...needsYouByProject([need], [])], []);
  const shared = needCopy(
    ProviderCapacityNeed.make({
      ...need,
      group: CapacityGroup.make({
        ...group,
        holder: GatewayCredentialHolder.make({ destination: SshDestination.make("usine@gateway") }),
      }),
    }),
  );
  assert.include(
    shared.title,
    "claude claude-sonnet-4-6 through gateway usine@gateway: at capacity since",
  );
});
