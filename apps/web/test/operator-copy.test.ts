import { SalvagePushed, SalvageRef, SalvageRetained } from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { ConfigFileNeed, UnconfiguredWorkerNeed } from "@usine/orchestrator/operator";
import { Option, Schema } from "effect";
import { assert, describe, it } from "vitest";
import { needCopy, salvageMessage } from "../src/operator-copy.ts";

describe("salvage copy in the run drawer", () => {
  it("names the pushed ref and short commit", () => {
    const message = salvageMessage(
      new SalvagePushed({
        ref: SalvageRef.make("usine/salvage/run/1"),
        commit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
      }),
    );
    assert.include(message, "usine/salvage/run/1");
    assert.include(message, "0123456");
  });

  it("shows where retained work lives, that startup retries it, and why the last try failed", () => {
    const message = salvageMessage(
      new SalvageRetained({
        path: "/workers/local/attempts/run_execute_1",
        commit: Option.none(),
        message: "git exited with code 128: remote: Repository not found.",
      }),
    );
    assert.include(message, "/workers/local/attempts/run_execute_1");
    assert.include(message, "every startup");
    assert.include(message, "remote: Repository not found.");
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
    assert.include(copy.detail, "restart usine up");
    assert.isNull(copy.runId);
  });

  it("names an invalid Agent file", () => {
    const copy = needCopy(need("agent", "agents/intern.md", "Expected a known harness"));
    assert.strictEqual(copy.title, "Agent file not loaded");
    assert.include(copy.detail, "agents/intern.md: Expected a known harness");
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
    assert.include(needCopy(need(1)).detail, "1 recorded Attempt and");
  });
});
