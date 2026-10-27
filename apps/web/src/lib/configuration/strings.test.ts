import { InstanceReload } from "@usine/orchestrator/current-instance";
import { Schema } from "effect";
import { assert, describe, it } from "vitest";
import { reloadSummary } from "~/lib/configuration/strings";

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
