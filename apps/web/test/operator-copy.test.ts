import { SalvagePushed, SalvageRef } from "@usine/core/attempt/salvage";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { InstanceReload } from "@usine/orchestrator/current-instance";
import {
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
    assert.include(message, "starts without it");
  });
});

describe("operator question copy in Needs you", () => {
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
    assert.strictEqual(copy.title, "act-on-findings asks a question");
    assert.strictEqual(copy.detail, "HTTP CONNECT or SOCKS for egress?");
    assert.strictEqual(copy.runId, "asked");
  });
});

describe("config file copy in Needs you", () => {
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
      "Settings changed",
      "1 file was left out; Needs you lists it",
    ]);
  });

  it("says when the folder matched the running configuration", () => {
    assert.deepStrictEqual(reloadSummary(reload({})), ["Nothing changed"]);
  });
});

describe("unconfigured Worker copy in Needs you", () => {
  const need = (attempts: number) =>
    new UnconfiguredWorkerNeed({
      id: "unconfigured-worker:local",
      worker: WorkerName.make("local"),
      attempts,
    });

  it("names the Worker, counts its Attempts, and gives both ways out", () => {
    const copy = needCopy(need(114));
    assert.strictEqual(copy.title, "Worker not configured");
    assert.include(copy.detail, "Worker local");
    assert.include(copy.detail, "114 recorded Attempts");
    assert.include(copy.detail, "Declare the Worker again");
    assert.include(copy.detail, "discard the leftovers");
    assert.include(needCopy(need(1)).detail, "1 recorded Attempt.");
  });
});
