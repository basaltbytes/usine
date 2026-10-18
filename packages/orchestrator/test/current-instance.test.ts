import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/config/label";
import { AgentName } from "@usine/core/agent";
import { InstanceDirectory } from "@usine/core/instance";
import { LoopName } from "@usine/core/loop";
import { Effect, FileSystem, Logger, Path } from "effect";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { reloadableInstanceLayer, writeInstanceFiles } from "./support/instance-folder.ts";

const usineYaml = (maxConcurrentAttempts = 1) => `version: 1
labels:
  - name: ready
repos:
  - name: basaltbytes/usine
workers:
  - name: local
    kind: local
    max_concurrent_attempts: ${maxConcurrentAttempts}
`;

const agentFile = (model: string) => `---
harness: codex
model: ${model}
effort: high
---
Implement the issue.
`;

const loopFile = (agent: string) => `---
trigger:
  on: issue
  if: item.labels.nodes.exists(label, label.name == "ready")
agent: ${agent}
step: implement
---
Implement issue #{{ item.number }}.
`;

const initialFiles = [
  ["usine.yaml", usineYaml()],
  ["agents/developer.md", agentFile("gpt-5.6-sol")],
  ["loops/start-dev.md", loopFile("developer")],
] as const;

/** Runs `test` against a reloadable instance over a fresh folder holding `initialFiles`. */
const withFolder = <A, E>(
  test: (
    root: InstanceDirectory,
  ) => Effect.Effect<A, E, CurrentInstance | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const root = InstanceDirectory.make(
      yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "usine-reload-" }),
    );
    yield* writeInstanceFiles(root, initialFiles);
    return yield* test(root).pipe(Effect.provide(reloadableInstanceLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const warningsIn = (messages: Array<unknown>) =>
  Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") messages.push(Array.isArray(message) ? message[0] : message);
  });

describe("CurrentInstance", () => {
  it.live("reports the Loops, Agents, and labels a reload added or changed", () =>
    withFolder((root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        yield* writeInstanceFiles(root, [
          [
            "usine.yaml",
            usineYaml().replace("  - name: ready\n", "  - name: ready\n  - name: triage\n"),
          ],
          ["agents/developer.md", agentFile("gpt-5.7-sol")],
          ["loops/triage.md", loopFile("developer")],
        ]);
        const report = yield* instances.reload;
        assert.deepStrictEqual(report.loops, {
          added: [LoopName.make("triage")],
          removed: [],
          changed: [],
        });
        assert.deepStrictEqual(report.agents, {
          added: [],
          removed: [],
          changed: [AgentName.make("developer")],
        });
        assert.deepStrictEqual(report.labels, {
          added: [GitHubLabelName.make("triage")],
          removed: [],
          changed: [],
        });
        assert.isFalse(report.settingsChanged);
        const current = yield* instances.get;
        assert.deepStrictEqual(
          current.loops.map(({ name }) => name),
          ["start-dev", "triage"],
        );
        assert.strictEqual(current.agents[0]?.model, "gpt-5.7-sol");
      }),
    ),
  );

  it.live("keeps the running instance when usine.yaml no longer loads", () =>
    withFolder((root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const running = yield* instances.get;
        const warnings: Array<unknown> = [];
        yield* writeInstanceFiles(root, [
          ["usine.yaml", "version: 1\nrepos: [}\n"],
          ["agents/developer.md", agentFile("gpt-5.7-sol")],
        ]);
        const failure = yield* instances.reload.pipe(
          Effect.flip,
          Effect.withLogger(warningsIn(warnings)),
        );
        assert(failure._tag === "FactoryConfigError", failure._tag);
        assert.strictEqual(failure.file, "usine.yaml");
        assert.include(
          warnings,
          "Instance folder reload rejected; the running configuration is unchanged",
        );
        assert.strictEqual(yield* instances.get, running);
      }),
    ),
  );

  it.live(
    "rejects a reload whose workers block changed, because Workers change only at startup",
    () =>
      withFolder((root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const running = yield* instances.get;
          yield* writeInstanceFiles(root, [
            ["usine.yaml", usineYaml(2)],
            ["loops/triage.md", loopFile("developer")],
          ]);
          const failure = yield* Effect.flip(instances.reload);
          assert(failure._tag === "RestartRequiredError", failure._tag);
          assert.deepStrictEqual(failure.blocks, ["workers"]);
          assert.include(failure.message, "restart usine up");
          assert.strictEqual(yield* instances.get, running);
        }),
      ),
  );

  it.live("leaves out a Loop that no longer loads and reports it as quarantined", () =>
    withFolder((root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const warnings: Array<unknown> = [];
        yield* writeInstanceFiles(root, [["loops/start-dev.md", loopFile("ghost")]]);
        const report = yield* instances.reload.pipe(Effect.withLogger(warningsIn(warnings)));
        assert.deepStrictEqual(report.loops.removed, [LoopName.make("start-dev")]);
        assert.deepStrictEqual(
          report.quarantinedLoops.map(({ file, error }) => [file, error.message]),
          [["loops/start-dev.md", "Unknown agent: ghost"]],
        );
        assert.include(warnings, "Loop quarantined; it opens no Runs until its file is fixed");
        const current = yield* instances.get;
        assert.deepStrictEqual(current.loops, []);
        assert.strictEqual(current.quarantinedLoops[0]?.file, "loops/start-dev.md");
      }),
    ),
  );
});
