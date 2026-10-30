import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/config/label";
import { AgentName } from "@usine/core/agent";
import { InstanceDirectory } from "@usine/core/instance";
import { LoopName } from "@usine/core/loop";
import { Executor, WorkerCapabilityError, fullPreflight } from "@usine/executor";
import { Effect, FileSystem, Layer, Logger, Path } from "effect";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { stepExecutorLayer } from "../src/scheduler/scheduler.ts";
import { testAppLayer } from "./support/github-app.ts";
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
  - name: spare
    kind: local
    max_concurrent_attempts: 1
`;

const agentFile = (model: string, harness = "codex", persona = "Implement the issue.") => `---
harness: ${harness}
model: ${model}
effort: high
---
${persona}
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

/** Runs `test` against a reloadable instance in a new folder with `initialFiles`. */
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

const unused = () => Effect.die("unused");

/**
 * Starts the Worker scheduler with an executor whose preflight records `worker: harness/model` for
 * each brain and fails on a `claude` brain.
 */
const startWorkers = (preflighted: Array<string>) =>
  Effect.gen(function* () {
    const { config, agents } = yield* (yield* CurrentInstance).get;
    const executor = Layer.succeed(Executor)({
      kind: "local",
      recover: unused,
      isLive: unused,
      outcome: unused,
      prepare: unused,
      cancel: unused,
      intervene: unused,
      sweep: Effect.void,
      preflight: (worker, brains) =>
        Effect.gen(function* () {
          preflighted.push(...brains.map(({ harness, model }) => `${worker}: ${harness}/${model}`));
          if (brains.some(({ harness }) => harness === "claude"))
            return yield* new WorkerCapabilityError({
              worker,
              capability: "harness-login",
              message: "Claude Code is not logged in.",
              cause: "claude auth status: logged out",
            });
          return fullPreflight;
        }),
    });
    yield* Layer.build(
      stepExecutorLayer(
        config,
        agents.map(({ agent }) => agent.brain),
      ).pipe(
        Layer.provide(MarcbachmannCelLayer),
        Layer.provide(executor),
        Layer.provide(testAppLayer),
      ),
    );
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

  it.live("keeps the running instance when the configuration store cannot be read", () =>
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
        assert.strictEqual(failure.file, ".usine/runtime.sqlite");
        assert.include(warnings, "Could not re-read the configuration store");
        assert.strictEqual(yield* instances.get, running);
      }),
    ),
  );

  it.live("rejects a workers change while no Worker runs, as in setup mode", () =>
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
        assert.deepStrictEqual(failure.fields, ["workers"]);
        assert.include(failure.message, "Restart usine up");
        assert.strictEqual(yield* instances.get, running);
      }),
    ),
  );

  it.live("rejects a reload whose webhooks or tracing block changed while Workers run", () =>
    withFolder((root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        yield* startWorkers([]);
        const running = yield* instances.get;
        yield* writeInstanceFiles(root, [
          [
            "usine.yaml",
            `${usineYaml(2)}webhooks:\n  mode: deliveries\ntracing:\n  otlp_url: http://localhost:4318/v1/traces\n`,
          ],
        ]);
        const failure = yield* Effect.flip(instances.reload);
        assert(failure._tag === "RestartRequiredError", failure._tag);
        assert.deepStrictEqual(failure.fields, ["webhooks", "tracing"]);
        assert.include(failure.message, "the webhooks block changed; the tracing block changed");
        assert.strictEqual(yield* instances.get, running);
      }).pipe(Effect.scoped),
    ),
  );

  it.live("preflights on every Worker only the brains a reload adds", () =>
    withFolder((root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const preflighted: Array<string> = [];
        yield* startWorkers(preflighted);
        preflighted.length = 0;

        yield* writeInstanceFiles(root, [
          ["agents/developer.md", agentFile("gpt-5.6-sol", "codex", "Implement and test it.")],
          ["loops/triage.md", loopFile("developer")],
        ]);
        const sameBrains = yield* instances.reload;
        assert.deepStrictEqual(sameBrains.agents.changed, [AgentName.make("developer")]);
        assert.deepStrictEqual(preflighted, [], "a reload that keeps every brain preflights none");

        yield* writeInstanceFiles(root, [["agents/developer.md", agentFile("gpt-5.7-sol")]]);
        yield* instances.reload;
        assert.sameMembers(preflighted, ["local: codex/gpt-5.7-sol", "spare: codex/gpt-5.7-sol"]);
        assert.strictEqual((yield* instances.get).agents[0]?.model, "gpt-5.7-sol");
      }).pipe(Effect.scoped),
    ),
  );

  it.live("refuses a reload whose new Agent fails Worker preflight and keeps the roster", () =>
    withFolder((root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        yield* startWorkers([]);
        const running = yield* instances.get;
        yield* writeInstanceFiles(root, [
          ["agents/reviewer.md", agentFile("claude-fable-5-1", "claude")],
          ["loops/review.md", loopFile("reviewer")],
        ]);
        const failure = yield* Effect.flip(instances.reload);
        assert(failure._tag === "ReloadPreflightError", failure._tag);
        assert.deepStrictEqual(failure.agents, [AgentName.make("reviewer")]);
        assert.include(failure.message, "Claude Code is not logged in");
        assert.include(failure.message, "The running configuration is unchanged");
        assert.strictEqual(yield* instances.get, running);
      }).pipe(Effect.scoped),
    ),
  );
});
