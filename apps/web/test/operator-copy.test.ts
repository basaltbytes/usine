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
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { assert, describe, it } from "vitest";
import { conflictingSalvageMessage, needCopy, reloadSummary } from "../src/operator-copy.ts";

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
    const copy = needCopy(need("loop", "loops/ghost.md", "Unknown agent: ghost"));
    assert.strictEqual(copy.title, "Loop quarantined");
    assert.include(copy.detail, "loops/ghost.md: Unknown agent: ghost");
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
              message: "Unknown agent: ghost",
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
      "1 file left out, listed in Needs attention",
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
    assert.include(copy.detail, "Declare the worker again");
    assert.include(copy.detail, "discard the leftovers");
    assert.include(needCopy(need(1)).detail, "1 recorded attempt on it");
  });

  it("says how many Attempts still run on a removed Worker", () => {
    assert.strictEqual(
      needCopy(need(3, 2)).detail,
      "local is not in usine.yaml. 2 attempts still run on it; discard its leftovers once they end",
    );
    assert.include(needCopy(need(3, 1)).detail, "1 attempt still runs on it");
  });
});
