import { AttemptNumber } from "@usine/core/attempt";
import { SalvagePushed, SalvageRef } from "@usine/core/attempt/salvage";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { InstanceReload } from "@usine/orchestrator/current-instance";
import {
  BlockedFailureView,
  ConfigFileNeed,
  QuestionFailureView,
  RunFailureNeed,
  UnconfiguredWorkerNeed,
  UnconfirmedStopNeed,
  UnconfirmedStopView,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { assert, describe, it } from "vitest";
import {
  conflictingSalvageMessage,
  creationFailuresLine,
  machineCreationLine,
  needCopy,
  nextCreationLine,
  reloadSummary,
  runStateLine,
} from "~/lib/strings";
import { machineFixture, pauseFixture } from "~/lib/runs/machine-fixture";

describe("salvage copy in the reader", () => {
  it("names the conflicting salvage a retry starts without", () => {
    const message = conflictingSalvageMessage(
      new SalvagePushed({
        ref: SalvageRef.make("usine/salvage/run/2"),
        commit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
      }),
    );
    assert.include(message, "usine/salvage/run/2 at 0123456");
    assert.include(message, "Not applied");
    assert.include(message, "conflicts with the current revision");
  });
});

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

describe("reload summary on the Loops page", () => {
  const reload = (encoded: Partial<typeof InstanceReload.Encoded>) =>
    Schema.decodeUnknownSync(InstanceReload)({
      loops: { added: [], removed: [], changed: [] },
      agents: { added: [], removed: [], changed: [] },
      labels: { added: [], removed: [], changed: [] },
      repos: { added: [], removed: [], changed: [] },
      workers: { added: [], removed: [], changed: [] },
      settingsChanged: false,
      operatorChanged: false,
      quarantinedLoops: [],
      invalidAgents: [],
      ...encoded,
    });

  it("names what each kind of change touched and the files left out", () => {
    const lines = reloadSummary(
      reload({
        loops: { added: ["triage"], removed: ["start-dev"], changed: [] },
        agents: { added: [], removed: [], changed: ["developer"] },
        workers: { added: [], removed: ["spare"], changed: ["local"] },
        settingsChanged: true,
        quarantinedLoops: [
          {
            file: "loops/start-dev.md",
            error: {
              _tag: "ConfigFileError",
              file: "loops/start-dev.md",
              stage: "reference",
              message:
                'Unknown agent "ghost": agents/ghost.md is missing or invalid. Fix the agent file, or set agent to an existing agent.',
            },
          },
        ],
      }),
    );
    assert.deepStrictEqual(lines, [
      "Loops added: triage",
      "Loops removed: start-dev",
      "Agents changed: developer",
      "Workers removed: spare",
      "Workers changed: local",
      "Settings changed",
      "1 file not loaded, listed in Needs attention",
    ]);
  });

  it("says when the folder matched the running configuration", () => {
    assert.deepStrictEqual(reloadSummary(reload({})), ["Nothing changed"]);
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

describe("run state while a parent task isn't confirmed stopped", () => {
  const stop = (runId: string) =>
    new UnconfirmedStopView({
      runId: RunId.make(runId),
      attemptNumber: AttemptNumber.make(1),
      worker: WorkerName.make("local"),
    });
  const run = { id: RunId.make("retrying"), state: "Running", attempts: [] } as const;

  it("names the run's own attempt and the worker it still ends on", () => {
    assert.strictEqual(
      runStateLine(run, stop("retrying")),
      "Waiting for attempt 1 to stop on local",
    );
  });

  it("names an earlier run's attempt", () => {
    assert.strictEqual(
      runStateLine(run, stop("canceled")),
      "Waiting for attempt 1 of an earlier run to stop on local",
    );
  });

  it("keeps the state without an unconfirmed stop", () => {
    assert.strictEqual(runStateLine(run), "Running, attempt 1");
  });
});

describe("machine copy for provisioned workers", () => {
  const local = (day: number, hours: number, minutes: number) =>
    new Date(2026, 9, day, hours, minutes).toISOString();
  const now = Date.parse(local(25, 19, 40));

  it("says a queued run's machine is being created, with the provider", () => {
    const queued = { id: RunId.make("queued"), state: "Queued", attempts: [] } as const;
    assert.strictEqual(
      runStateLine(queued, null, machineFixture({ provider: "boat" })),
      "Queued, creating a Boat machine",
    );
    assert.strictEqual(
      runStateLine(queued, null, machineFixture({ state: "ready", id: "52341896" })),
      "Queued, no free worker",
    );
    assert.strictEqual(
      machineCreationLine(machineFixture({ since: local(25, 19, 37) }), now),
      "Creating a Hetzner machine, started 3m ago",
    );
  });

  it("gives the next creation time, with the day once it is not today", () => {
    assert.strictEqual(
      nextCreationLine(pauseFixture({ retryAt: local(25, 19, 46) }), now),
      "Next try at 19:46",
    );
    assert.strictEqual(
      nextCreationLine(pauseFixture({ retryAt: local(26, 7, 46) }), now),
      "Next try at 26 Oct 07:46",
    );
    assert.strictEqual(
      nextCreationLine(pauseFixture({ retryAt: local(25, 19, 30), blocked: false }), now),
      "Pause ended at 19:30",
    );
  });

  it("counts failed creations in a row", () => {
    assert.strictEqual(
      creationFailuresLine(pauseFixture({ failures: 1, failedAt: local(25, 19, 31) }), now),
      "Failed once, last at 19:31",
    );
    assert.strictEqual(
      creationFailuresLine(pauseFixture({ failures: 4, failedAt: local(24, 23, 2) }), now),
      "Failed 4 times in a row, last at 24 Oct 23:02",
    );
  });
});
