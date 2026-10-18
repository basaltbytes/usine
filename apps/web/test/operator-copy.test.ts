import { SalvagePushed, SalvageRef, SalvageRetained } from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import { InstanceReload } from "@usine/orchestrator/current-instance";
import { ConfigFileNeed } from "@usine/orchestrator/operator";
import { Option, Schema } from "effect";
import { assert, describe, it } from "vitest";
import { needCopy, reloadSummary, salvageMessage } from "../src/operator-copy.ts";

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
