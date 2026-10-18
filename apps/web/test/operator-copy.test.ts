import { SalvagePushed, SalvageRef, SalvageRetained } from "@usine/core/attempt/salvage";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { ConfigFileNeed, QuestionFailureView, RunFailureNeed } from "@usine/orchestrator/operator";
import { Option, Schema } from "effect";
import { assert, describe, it } from "vitest";
import { conflictingSalvageMessage, needCopy, salvageMessage } from "../src/operator-copy.ts";

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
    assert.include(copy.detail, "restart usine up");
    assert.isNull(copy.runId);
  });

  it("names an invalid Agent file", () => {
    const copy = needCopy(need("agent", "agents/intern.md", "Expected a known harness"));
    assert.strictEqual(copy.title, "Agent file not loaded");
    assert.include(copy.detail, "agents/intern.md: Expected a known harness");
  });
});
