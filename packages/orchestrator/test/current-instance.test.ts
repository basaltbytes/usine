import { ChangeBus, changeBusLayer } from "@usine/core/changes";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { InstancePath } from "@usine/config/file";
import { GitHubLabelName } from "@usine/config/label";
import { DurableHarness } from "@usine/durable/harness";
import { gatewayModelAccess } from "@usine/durable/gateway";
import { fauxParent } from "@usine/durable/testing";
import { parentAdmissionLayer } from "../src/current-instance/parents.ts";
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
  files: ReadonlyArray<readonly [string, string]> = initialFiles,
) =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "usine-reload-",
    });
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, files);
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
            return yield* WorkerCapabilityError.make({
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
  it.live.each(["model", "effort", "credential"] as const)(
    "quarantines a refused parent at startup (%s) and restores it on a corrected reload",
    (reason) =>
      withFolder(
        (root) =>
          Effect.gen(function* () {
            const instances = yield* CurrentInstance;
            const parent = fauxParent([]);
            const provider = parent.models.getProvider("faux");
            assert(provider !== undefined);
            if (reason === "credential") parent.models.setProvider({ ...provider, auth: {} });
            yield* Layer.build(parentAdmissionLayer).pipe(
              Effect.provideService(DurableHarness, {
                ...parent,
                install: unused,
                resume: unused,
                use: unused,
                subscribe: unused,
              }),
            );
            const quarantined = yield* instances.get;
            assert.lengthOf(quarantined.agents, reason === "credential" ? 0 : 1);
            assert.lengthOf(quarantined.loops, reason === "credential" ? 0 : 1);
            assert.include(
              quarantined.invalidAgents.map(({ file }) => file),
              InstancePath.make("agents/developer.md"),
            );
            assert.include(
              quarantined.quarantinedLoops.map(({ file }) => file),
              InstancePath.make("loops/start-dev.md"),
            );
            assert.include(
              quarantined.invalidAgents[0]?.error.message ?? "",
              "cannot run as coordinator",
            );
            parent.models.setProvider(provider);
            yield* writeInstanceFiles(root, [["agents/developer.md", agentFile("gpt-5.6-sol")]]);
            yield* instances.reload;
            const restored = yield* instances.get;
            assert.lengthOf(restored.agents, 2);
            assert.lengthOf(restored.loops, 2);
            assert.lengthOf(restored.invalidAgents, 0);
            assert.lengthOf(restored.quarantinedLoops, 0);
          }).pipe(Effect.scoped),
        [
          ...initialFiles.filter(([file]) => file !== "agents/developer.md"),
          [
            "agents/developer.md",
            agentFile("gpt-5.6-sol").replace(
              "effort: high",
              reason === "model"
                ? "effort: high\nparent_model: unknown/x"
                : reason === "effort"
                  ? "effort: high\nparent_effort: max"
                  : "effort: high",
            ),
          ],
          ["agents/healthy.md", agentFile("gpt-5.6-sol")],
          ["loops/healthy.md", loopFile("healthy")],
        ],
      ),
  );

  it.live("validates gateway credentials at startup and reload without a local login", () =>
    withFolder(
      () =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          let connected = false;
          const access = gatewayModelAccess({
            credential: (protocol) =>
              Promise.resolve(
                protocol === "anthropic-messages"
                  ? "api-key"
                  : connected
                    ? "subscription"
                    : undefined,
              ),
            request: () => Promise.reject(new Error("admission does not send model requests")),
          });
          yield* Layer.build(parentAdmissionLayer).pipe(
            Effect.provideService(DurableHarness, {
              ...fauxParent([]),
              models: access.models,
              parentAuthentication: access.authentication,
              install: unused,
              resume: unused,
              use: unused,
              subscribe: unused,
            }),
          );
          const quarantined = yield* instances.get;
          assert.deepStrictEqual(
            quarantined.agents.map(({ name }) => name),
            ["healthy"],
          );
          assert.include(
            quarantined.invalidAgents[0]?.error.message ?? "",
            'Gateway credential unavailable for provider "openai-codex"',
          );
          connected = true;
          yield* instances.reload;
          const running = yield* instances.get;
          assert.lengthOf(running.agents, 2);
          assert.lengthOf(running.invalidAgents, 0);
          connected = false;
          const failure = yield* Effect.flip(instances.reload);
          assert.include(
            failure.message,
            'Gateway credential unavailable for provider "openai-codex"',
          );
          const rejected = yield* instances.get;
          assert.strictEqual(rejected, running);
        }).pipe(Effect.scoped),
      [
        ...initialFiles.filter(([file]) => file !== "agents/developer.md"),
        [
          "agents/developer.md",
          agentFile("gpt-5.6-sol").replace(
            "effort: high",
            "effort: high\nparent_model: openai-codex/gpt-5.6-sol",
          ),
        ],
        [
          "agents/healthy.md",
          agentFile("gpt-5.6-sol").replace(
            "effort: high",
            "effort: high\nparent_model: anthropic/claude-fable-5-1",
          ),
        ],
        ["loops/healthy.md", loopFile("healthy")],
      ],
    ),
  );

  it.live.each([
    ["agent", "parent_model", "unknown-provider/nonexistent-model", "no model"],
    ["settings", "parent_model", "unknown-provider/nonexistent-model", "no model"],
    ["agent", "parent_effort", "max", "doesn't support effort"],
    ["settings", "parent_effort", "max", "doesn't support effort"],
  ] as const)(
    "refuses an invalid %s %s before installing a reload",
    ([source, field, value, diagnostic]) =>
      withFolder((root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const running = yield* instances.get;
          yield* Layer.build(parentAdmissionLayer).pipe(
            Effect.provideService(DurableHarness, {
              ...fauxParent([]),
              install: unused,
              resume: unused,
              use: unused,
              subscribe: unused,
            }),
          );
          yield* writeInstanceFiles(
            root,
            source === "agent"
              ? [
                  [
                    "agents/developer.md",
                    agentFile("gpt-5.6-sol").replace(
                      "effort: high",
                      `effort: high\n${field}: ${value}`,
                    ),
                  ],
                ]
              : [["usine.yaml", `${usineYaml()}settings:\n  ${field}: ${value}\n`]],
          );
          const failure = yield* Effect.flip(instances.reload);
          assert(failure._tag === "FactoryConfigError", failure._tag);
          assert.include(failure.message, diagnostic);
          assert.include(failure.message, 'Agent "developer" cannot run as coordinator');
          const rejected = yield* instances.get;
          assert.strictEqual(rejected, running);

          yield* writeInstanceFiles(root, [
            [
              "agents/developer.md",
              agentFile("gpt-5.6-sol").replace(
                "effort: high",
                "effort: high\nparent_model: faux/faux-1\nparent_effort: high",
              ),
            ],
            ["usine.yaml", usineYaml()],
          ]);
          yield* instances.reload;
          const accepted = yield* instances.get;
          assert.notStrictEqual(accepted, running);
        }).pipe(Effect.scoped),
      ),
  );

  it.live("keeps the running configuration when a parent credential becomes unavailable", () =>
    withFolder(() =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const parent = fauxParent([]);
        yield* Layer.build(parentAdmissionLayer).pipe(
          Effect.provideService(DurableHarness, {
            ...parent,
            install: unused,
            resume: unused,
            use: unused,
            subscribe: unused,
          }),
        );
        yield* instances.reload;
        const running = yield* instances.get;
        const provider = parent.models.getProvider("faux");
        assert(provider !== undefined);
        parent.models.setProvider({ ...provider, auth: {} });
        const failure = yield* Effect.flip(instances.reload);
        assert(failure._tag === "FactoryConfigError", failure._tag);
        assert.include(failure.message, "requires a credential");
        const rejected = yield* instances.get;
        assert.strictEqual(rejected, running);
      }).pipe(Effect.scoped),
    ),
  );

  it.live("reports the Loops, Agents, and labels a reload added or changed", () =>
    withFolder((root) =>
      Effect.gen(function* () {
        const bus = yield* ChangeBus;
        const before = (yield* bus.open).revision;
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
        const journal = yield* bus.open;
        assert.strictEqual(journal.revision, before + 1);
        assert(
          journal.history
            .at(-1)
            ?.changes.some(
              ({ audience, target }) =>
                audience._tag === "Readers" && target.kind === "configuration",
            ),
        );
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
      }).pipe(Effect.scoped),
    ).pipe(Effect.provide(changeBusLayer), Effect.scoped),
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
        const currentInstance = yield* instances.get;
        assert.strictEqual(currentInstance, running);
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
        const currentInstance = yield* instances.get;
        assert.strictEqual(currentInstance, running);
      }),
    ),
  );

  it.live("rejects tracing and auth changes while accepting webhook changes independently", () =>
    withFolder((root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        yield* startWorkers([]);
        const running = yield* instances.get;
        yield* writeInstanceFiles(root, [
          [
            "usine.yaml",
            `${usineYaml(2)}webhooks:\n  mode: deliveries\ntracing:\n  otlp_url: http://localhost:4318/v1/traces\nauth:\n  origins: [https://client.example]\n`,
          ],
        ]);
        const failure = yield* Effect.flip(instances.reload);
        assert(failure._tag === "RestartRequiredError", failure._tag);
        assert.deepStrictEqual(failure.fields, ["tracing", "auth"]);
        assert.include(failure.message, "the tracing block changed; the auth block changed");
        const currentInstance = yield* instances.get;
        assert.strictEqual(currentInstance, running);
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
        const currentInstance = yield* instances.get;
        assert.strictEqual(currentInstance, running);
      }).pipe(Effect.scoped),
    ),
  );
});
