import { jsonKey } from "@usine/core/json-key";
import { catalog } from "@usine/agents/harness";
import { SupervisorSandbox } from "@usine/agents/supervisor";
import { EnginePersistenceError } from "@usine/engine/engine";
import { NodeFileSystem, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/core/label";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { InstanceDirectory, InstanceId } from "@usine/core/instance";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import {
  ContainerCpus,
  ContainerLimits,
  ContainerMemoryMib,
  ContainerPids,
  WorkerName,
} from "@usine/core/worker";
import { LoopControl, LoopRuntimeState } from "@usine/engine/loop-control";
import {
  RepositoryLabelProjection,
  RepositoryLabelProjectionReader,
} from "@usine/engine/repository-label-projection";
import { fullPreflight, WorkerCapabilityError } from "@usine/executor";
import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  PlatformError,
  Result,
  Schema,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { idleTriggersLayer } from "../src/idle-triggers.ts";
import { LabelPreflightFinding } from "../src/label-reconciler.ts";
import { ConfigurationView, OperatorConfiguration } from "../src/operator/configuration/view.ts";
import { workerPreflightView } from "../src/operator/preflight.ts";
import { PollCycle, PollingTriggers } from "../src/polling-triggers.ts";
import { supervisorSandboxLayer } from "../src/supervisor-sandbox.ts";
import { recordPreflight, unchecked, WorkerStatus } from "../src/worker-status.ts";
import { reloadableInstanceLayer, writeInstanceFiles } from "./support/instance-folder.ts";

const usine = RepositoryName.make("basaltbytes/usine");
const site = RepositoryName.make("basaltbytes/site");
const local = WorkerName.make("local");
const startedAt = DateTime.makeUnsafe("2026-10-20T08:00:00.000Z");

const files = [
  [
    "usine.yaml",
    `version: 1
operator: PhilDL
labels:
  - name: ready
    color: 0e8a16
  - name: ready-for-review
repos:
  - name: basaltbytes/usine
    tags: [engine]
    lanes:
      - name: Ready
        sources: [{ label: ready }]
      - name: In review
        sources: [{ label: ready-for-review }, { state: pr-open }]
      - name: Findings
        sources: [{ label: review-findings }]
  - name: basaltbytes/site
settings:
  poll_interval: 30
  parent_model: gpt-5.6-sol
webhooks:
  mode: endpoint
  public_url: https://factory.example/webhooks
tracing:
  otlp_url: http://localhost:4318/v1/traces
workers:
  - name: local
    kind: local
    max_concurrent_attempts: 2
  - name: eu-1
    kind: ssh
    paused: true
    destination: usine@eu-1
    root: /srv/usine
    identity_file: ~/.ssh/usine_worker
    gateway:
      domain: gw.internal
      destination: usine-gateway
      admin_token_env: USINE_GATEWAY_ADMIN_TOKEN
      llm_providers: [anthropic-messages]
`,
  ],
  [
    "agents/developer.md",
    `---
harness: codex
model: gpt-5.6-sol
effort: high
parent_effort: medium
---
Implement the issue, then open a pull request.
`,
  ],
  [
    "agents/reviewer.md",
    `---
harness: claude
model: claude-opus-4-1
effort: xhigh
parent_model: claude-sonnet-4-5
---
Review the pull request.
`,
  ],
  [
    "agents/triager.md",
    `---
harness: codex
model: gpt-5.6-sol
effort: low
coordinator: events
---
Label the issue.
`,
  ],
  ["agents/broken.md", "---\nharness: [\n---\nNo brain.\n"],
  [
    "loops/start-dev.md",
    `---
trigger:
  on: issue
  if: item.labels.nodes.exists(label, label.name == "ready" || label.name == "urgent")
agent: developer
step: implement
approval: required
max_cycles: 5
---
Implement issue #{{ item.number }} in {{ repo.name }}.
`,
  ],
  [
    "loops/review.md",
    `---
trigger:
  on: pr
  if: "true"
selector:
  tags: [engine]
agent: reviewer
permissions: read
priority: 2
step: review
outcome_labels: [ready, review-pased]
---
Review the pull request.
`,
  ],
  [
    "loops/nightly.md",
    `---
trigger:
  on: schedule
  if: "true"
  cron: "0 3 * * *"
  tz: Europe/Paris
selector:
  repos: [basaltbytes/site]
agent: developer
step: sweep
---
Sweep the repository.
`,
  ],
  [
    "loops/ghost.md",
    `---
trigger:
  on: issue
  if: "true"
agent: ghost
step: run
---
Nobody runs this.
`,
  ],
] as const;

const labels = Layer.succeed(RepositoryLabelProjectionReader)({
  get: (repository) =>
    Effect.gen(function* () {
      const decodedValue1 = yield* Schema.decodeEffect(RepositoryLabelProjection)({
        repository,
        labels: [
          { name: "Ready", color: "0e8a16", description: "Ready for an Agent" },
          { name: "review-findings", color: "d93f0b", description: null },
        ],
      });
      return yield* Effect.succeed(
        repository === usine ? Option.some(decodedValue1) : Option.none(),
      );
    }).pipe(
      Effect.mapError((cause) =>
        EnginePersistenceError.make({ operation: "read label fixture", cause }),
      ),
    ),
});

const finding = LabelPreflightFinding.make({
  repository: usine,
  label: GitHubLabelName.make("ready-for-review"),
  errorTag: "GitHubApiError",
  message: "GitHub returned HTTP status 403",
});

const polling = Layer.succeed(PollingTriggers)({
  lastHint: Effect.succeedSome(DateTime.makeUnsafe("2026-10-29T12:00:00Z")),
  hint: () => Effect.void,
  poll: () => Effect.die("unused"),
  run: () => Effect.never,
  latest: Effect.succeedSome(
    PollCycle.make({
      repositories: 2,
      changedItems: 0,
      submissions: [],
      revokedRuns: 0,
      failures: [],
      preflightFindings: [finding],
      nextPollAt: Option.none(),
    }),
  ),
});

const controls = Layer.succeed(LoopControl)({
  isPaused: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  unpause: () => Effect.die("unused"),
  states: Effect.succeed([
    LoopRuntimeState.make({ loop: LoopName.make("start-dev"), paused: true }),
    LoopRuntimeState.make({ loop: LoopName.make("review"), paused: false }),
  ]),
});

const kernelLogFinding =
  "The SSH user can't read the kernel journal or ring buffer on usine@eu-1, so out-of-memory kills record no process names. Add the user to the systemd-journal group.";

const claudeLoggedOut = WorkerCapabilityError.make({
  worker: local,
  capability: "harness-login",
  message: "Claude Code is not logged in on Worker local",
  cause: HarnessUnavailableError.make({
    harness: Harness.make("claude"),
    capability: "login",
    message: "Claude Code is not logged in",
  }),
});

const workers = Layer.succeed(WorkerStatus)({
  checking: Effect.succeed(new Set()),
  runPreflight: () => Effect.die("unused"),
  unavailable: Effect.succeed([]),
  slots: Effect.succeed([
    { worker: local, capacity: 2, leased: 1 },
    { worker: WorkerName.make("retired"), capacity: 0, leased: 1 },
  ]),
  queue: Effect.succeed([]),
  machines: Effect.succeed([]),
  machineStarts: Effect.succeed([]),
  provisioning: Effect.succeed([]),
  preflights: Effect.sync(() => {
    const codex = BrainSpec.make({
      harness: Harness.make("codex"),
      model: ModelId.make("gpt-5.6-sol"),
      effort: "high",
    });
    const claude = BrainSpec.make({
      harness: Harness.make("claude"),
      model: ModelId.make("claude-opus-4-1"),
      effort: "xhigh",
    });
    const started = recordPreflight(
      unchecked(local),
      [codex],
      startedAt,
      Result.succeed(fullPreflight),
    );
    const limits = ContainerLimits.make({
      cpus: ContainerCpus.make(1.16),
      memoryMib: ContainerMemoryMib.make(2389),
      pids: ContainerPids.make(20325),
    });
    return [
      recordPreflight(
        started,
        [codex, claude],
        DateTime.addDuration(startedAt, "1 hour"),
        Result.fail(claudeLoggedOut),
      ),
      recordPreflight(
        unchecked(WorkerName.make("eu-1")),
        [claude],
        startedAt,
        Result.succeed({
          ...fullPreflight,
          containerLimits: Option.some(limits),
          findings: [kernelLogFinding],
        }),
      ),
    ];
  }),
});

const readConfigurationOf = Effect.fn("test.readConfigurationOf")(
  function* (
    instanceFiles: ReadonlyArray<readonly [string, string]>,
    sandbox: Layer.Layer<never, never, CurrentInstance> = Layer.empty,
  ) {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "usine-config-",
    });
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, instanceFiles);
    return yield* Effect.gen(function* () {
      const instance = yield* (yield* CurrentInstance).get;

      return yield* (yield* OperatorConfiguration).view(instance);
    }).pipe(
      Effect.provide(
        OperatorConfiguration.layer.pipe(
          Layer.provide(Layer.mergeAll(controls, labels, polling, workers, sandbox)),
          Layer.provideMerge(reloadableInstanceLayer(root)),
        ),
      ),
      Effect.flatMap(Schema.encodeEffect(ConfigurationView)),
    );
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

const readConfiguration = readConfigurationOf(files);

/** A host on which no command is installed, so neither Podman nor Docker. */
const withoutContainerRuntime = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
  ChildProcessSpawner.make((command) =>
    command._tag === "StandardCommand"
      ? PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: `spawn ${command.command} ENOENT`,
        })
      : Effect.die("unexpected pipeline"),
  ),
);

/** A logger that records the message of each warning in `warnings`. */
const warningsIn = (warnings: Array<unknown>) =>
  Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });

/**
 * The instance files with `settings.coordinator: events` in place of `settings.parent_model`, and
 * with both time limits set.
 */
const eventsFiles = files.map(([path, content]) =>
  path === "usine.yaml"
    ? ([
        path,
        content.replace(
          "  parent_model: gpt-5.6-sol\n",
          "  coordinator: events\n  max_attempt_minutes: 600\n  max_background_wait_minutes: 5\n",
        ),
      ] as const)
    : ([path, content] as const),
);

const supervisorFiles = files.map(([path, content]) =>
  path === "usine.yaml"
    ? ([
        path,
        content.replace(
          "  parent_model: gpt-5.6-sol\n",
          "  parent_model: gpt-5.6-sol\n  supervisor:\n    harness: claude\n    model: claude-sonnet-5-5\n    effort: medium\n",
        ),
      ] as const)
    : ([path, content] as const),
);

describe("Configuration view", () => {
  it.effect("shows each Loop as parsed, with its pause, its repositories, and its file", () =>
    Effect.gen(function* () {
      const view = yield* readConfiguration;
      const byName = new Map(view.loops.map((loop) => [loop.name, loop]));
      const startDev = byName.get(LoopName.make("start-dev"));
      assert(startDev !== undefined, "start-dev is loaded");
      assert.strictEqual(startDev.file, "loops/start-dev.md");
      assert.strictEqual(startDev.stream, "issue");
      assert.strictEqual(
        startDev.condition,
        'item.labels.nodes.exists(label, label.name == "ready" || label.name == "urgent")',
      );
      assert.isNull(startDev.selector);
      assert.deepStrictEqual(startDev.repositories, [usine, site]);
      assert.strictEqual(startDev.approval, "required");
      assert.strictEqual(startDev.maxCycles, 5);
      assert.strictEqual(startDev.permissions, "write");
      assert.isNull(startDev.priority);
      assert.strictEqual(startDev.step, "implement");
      assert.strictEqual(startDev.agent, "developer");
      assert.strictEqual(
        startDev.prompt,
        "Implement issue #{{ item.number }} in {{ repo.name }}.\n",
      );
      assert.isTrue(startDev.paused);
      assert.deepStrictEqual(startDev.undeclaredLabels, ["urgent"]);
      assert.deepStrictEqual(startDev.outcomeLabels, []);
      assert.deepStrictEqual(startDev.undeclaredOutcomeLabels, []);

      const review = byName.get(LoopName.make("review"));
      assert(review !== undefined, "review is loaded");
      assert.deepStrictEqual(review.selector, { repos: null, tags: ["engine"] });
      assert.deepStrictEqual(review.repositories, [usine]);
      assert.strictEqual(review.permissions, "read");
      assert.strictEqual(review.priority, 2);
      assert.deepStrictEqual(review.outcomeLabels, ["ready", "review-pased"]);
      assert.deepStrictEqual(review.undeclaredOutcomeLabels, ["review-pased"]);
      assert.isFalse(review.paused);

      const nightly = byName.get(LoopName.make("nightly"));
      assert(nightly !== undefined, "nightly is loaded");
      assert.strictEqual(nightly.stream, "schedule");
      assert.strictEqual(nightly.cron, "0 3 * * *");
      assert.strictEqual(nightly.timeZone, "Europe/Paris");
      assert.deepStrictEqual(nightly.repositories, [site]);

      assert.deepStrictEqual(
        view.quarantinedLoops.map(({ name, file, error }) => [name, file, error.stage]),
        [["ghost", "loops/ghost.md", "reference"]],
      );
    }),
  );

  it.effect("shows each Agent with its parent settings resolved and the Loops that name it", () =>
    Effect.gen(function* () {
      const view = yield* readConfiguration;
      const developer = view.agents.find(({ name }) => name === "developer");
      const reviewer = view.agents.find(({ name }) => name === "reviewer");
      assert(developer !== undefined && reviewer !== undefined, "both Agents load");
      assert.strictEqual(developer.file, "agents/developer.md");
      assert.deepStrictEqual(
        [developer.harness, developer.model, developer.effort],
        ["codex", "gpt-5.6-sol", "high"],
      );
      assert.isNull(developer.parentModel);
      assert.strictEqual(developer.resolvedParentModel, "gpt-5.6-sol");
      assert.strictEqual(developer.parentEffort, "medium");
      assert.strictEqual(developer.resolvedParentEffort, "medium");
      assert.strictEqual(developer.persona, "Implement the issue, then open a pull request.\n");
      assert.deepStrictEqual([...developer.loops].sort(), ["nightly", "start-dev"]);

      assert.strictEqual(reviewer.resolvedParentModel, "claude-sonnet-4-5");
      assert.strictEqual(reviewer.resolvedParentEffort, "xhigh");
      assert.deepStrictEqual(reviewer.loops, ["review"]);

      const triager = view.agents.find(({ name }) => name === "triager");
      assert.deepStrictEqual(
        [developer, triager].map((agent) => [agent?.coordinator, agent?.resolvedCoordinator]),
        [
          [null, "session"],
          ["events", "events"],
        ],
      );

      assert.deepStrictEqual(
        view.invalidAgents.map(({ name, file }) => [name, file]),
        [["broken", "agents/broken.md"]],
      );
    }),
  );

  it.effect("shows each Worker with its slots and last preflight, and never a secret", () =>
    Effect.gen(function* () {
      const view = yield* readConfiguration;
      const [onLocal, onSsh] = view.workers;
      assert(onLocal !== undefined && onSsh !== undefined, "both Workers are declared");
      assert.strictEqual(onLocal.kind, "local");
      assert.strictEqual(onLocal.maxConcurrentAttempts, 2);
      assert.isFalse(onLocal.paused);
      assert.deepStrictEqual(onLocal.slots, { capacity: 2, leased: 1 });
      assert.isNull(onLocal.destination);
      assert.deepStrictEqual(onLocal.prerequisites, {
        _tag: "Passed",
        checkedAt: "2026-10-20T08:00:00.000Z",
      });
      assert.deepStrictEqual(
        onLocal.harnesses.map(({ harness, check }) => [harness, check._tag, check.checkedAt]),
        [
          ["claude", "Failed", "2026-10-20T09:00:00.000Z"],
          ["codex", "Passed", "2026-10-20T09:00:00.000Z"],
        ],
      );
      const failed = onLocal.harnesses[0]?.check;
      assert(failed?._tag === "Failed", "claude failed");
      assert.strictEqual(failed.capability, "harness-login");
      assert.strictEqual(failed.message, "Claude Code is not logged in on Worker local");

      assert.strictEqual(onSsh.kind, "ssh");
      assert.isTrue(onSsh.paused);
      assert.strictEqual(onSsh.destination, "usine@eu-1");
      assert.strictEqual(onSsh.root, "/srv/usine");
      assert.strictEqual(onSsh.identityFile, "~/.ssh/usine_worker");
      assert.isNull(onSsh.port);
      assert.isNull(onSsh.slots);
      assert.deepStrictEqual(onSsh.prerequisites, {
        _tag: "Passed",
        checkedAt: "2026-10-20T08:00:00.000Z",
      });
      assert.deepStrictEqual(onSsh.containerLimits, { cpus: 1.16, memoryMib: 2389, pids: 20325 });
      assert.isNull(onLocal.containerLimits);
      assert.deepStrictEqual(onSsh.findings, [kernelLogFinding]);
      assert.deepStrictEqual(onLocal.findings, []);
      assert.deepStrictEqual(onSsh.gateway, {
        domain: "gw.internal",
        destination: "usine-gateway",
        adminPort: 7070,
        adminTokenEnv: "USINE_GATEWAY_ADMIN_TOKEN",
        llmProviders: ["anthropic-messages"],
      });
      assert.deepStrictEqual(view.removedWorkers, [{ name: "retired", running: 1 }]);

      const encoded = jsonKey(view);
      assert.include(encoded, "USINE_GATEWAY_ADMIN_TOKEN");
      assert.notInclude(encoded, '"adminToken"');
    }),
  );

  it.effect("carries each Worker's preflight findings into its preflight view", () =>
    Effect.gen(function* () {
      const preflights = yield* (yield* WorkerStatus).preflights;
      assert.deepStrictEqual(
        preflights.map(workerPreflightView).map(({ worker, findings }) => ({ worker, findings })),
        [
          { worker: local, findings: [] },
          { worker: WorkerName.make("eu-1"), findings: [kernelLogFinding] },
        ],
      );
    }).pipe(Effect.provide(workers)),
  );

  it.effect("shows each repository's lanes in order with their labels as GitHub has them", () =>
    Effect.gen(function* () {
      const view = yield* readConfiguration;
      const [engine, website] = view.repositories;
      assert(engine !== undefined && website !== undefined, "both repositories are registered");
      assert.deepStrictEqual(engine.tags, ["engine"]);
      assert.deepStrictEqual(
        engine.lanes.map(({ name }) => name),
        ["Ready", "In review", "Findings"],
      );
      const [ready, inReview, findings] = engine.lanes;
      assert.deepStrictEqual(ready?.sources[0], {
        _tag: "Label",
        label: {
          name: "ready",
          onGitHub: true,
          color: "0e8a16",
          description: "Ready for an Agent",
          declared: true,
          failure: null,
        },
      });
      const [forReview, prOpen] = inReview?.sources ?? [];
      assert(forReview?._tag === "Label", "In review starts with a label");
      assert.isFalse(forReview.label.onGitHub);
      assert.isTrue(forReview.label.declared);
      const decodedValue3 = yield* Schema.encodeEffect(LabelPreflightFinding)(finding);
      assert.deepStrictEqual(forReview.label.failure, decodedValue3);
      assert.deepStrictEqual(prOpen, { _tag: "State", state: "pr-open" });
      const [reviewFindings] = findings?.sources ?? [];
      assert(reviewFindings?._tag === "Label", "Findings has a label");
      assert.isTrue(reviewFindings.label.onGitHub);
      assert.isFalse(reviewFindings.label.declared);
      assert.deepStrictEqual(
        engine.declaredLabels.map(({ name, onGitHub }) => [name, onGitHub]),
        [
          ["ready", true],
          ["ready-for-review", false],
        ],
      );
      assert.deepStrictEqual([...engine.loops].sort(), ["review", "start-dev"]);

      assert.deepStrictEqual(website.lanes, []);
      assert.deepStrictEqual(
        website.declaredLabels.map(({ name, onGitHub, color }) => [name, onGitHub, color]),
        [
          ["ready", null, "0e8a16"],
          ["ready-for-review", null, null],
        ],
      );
      assert.deepStrictEqual([...website.loops].sort(), ["nightly", "start-dev"]);
    }),
  );

  it.effect("shows settings with their defaults applied, the operator, webhooks, and tracing", () =>
    Effect.gen(function* () {
      const view = yield* readConfiguration;
      assert.deepStrictEqual(view.settings, {
        pollInterval: 30,
        maxChildren: 4,
        maxAttemptMinutes: null,
        maxAttemptTokens: null,
        maxBackgroundWaitMinutes: null,
        parentModel: "gpt-5.6-sol",
        parentEffort: null,
        coordinator: "session",
        supervisor: null,
        operator: "PhilDL",
        webhooks: "endpoint",
        lastHintAt: "2026-10-29T12:00:00.000Z",
        webhooksPublicUrl: "https://factory.example/webhooks",
        tracing: { otlpUrl: "http://localhost:4318/v1/traces", serviceName: "usine" },
      });
    }),
  );

  it.effect("shows the supervisor's brain, and null when the role is not configured", () =>
    Effect.gen(function* () {
      const unset = yield* readConfiguration;
      assert.isNull(unset.settings.supervisor);
      const view = yield* readConfigurationOf(supervisorFiles);
      assert.deepStrictEqual(view.settings.supervisor, {
        harness: "claude",
        model: "claude-sonnet-5-5",
        effort: "medium",
        ownTools: null,
        unavailable: "This orchestrator provides no supervisor sandbox",
      });
    }),
  );

  it.effect("says when the supervisor's harness keeps its own tools, and whether it can run", () =>
    Effect.gen(function* () {
      const codexFiles = supervisorFiles.map(([path, content]) =>
        path === "usine.yaml"
          ? ([
              path,
              content
                .replace("    harness: claude\n", "    harness: codex\n")
                .replace("    model: claude-sonnet-5-5\n", "    model: gpt-5.6-terra\n"),
            ] as const)
          : ([path, content] as const),
      );
      const available = Layer.succeed(SupervisorSandbox)({
        unavailable: Option.none(),
        open: () => Effect.die("the view opens no sandbox"),
      });
      const view = yield* readConfigurationOf(codexFiles, available);
      const kept = Option.flatMap(catalog.get(Harness.make("codex")), ({ capabilities }) =>
        Option.fromNullishOr(
          capabilities
            .flatMap(({ lacking }) => lacking)
            .find(({ capability }) => capability === "closed-tools"),
        ),
      );
      assert(Option.isSome(kept));
      assert.deepStrictEqual(view.settings.supervisor, {
        harness: "codex",
        model: "gpt-5.6-terra",
        effort: "medium",
        ownTools: kept.value.reason,
        unavailable: null,
      });
    }),
  );

  it.effect(
    "reports the orchestrator's supervisor as unavailable, with the reason, on a host without a container runtime",
    () =>
      Effect.gen(function* () {
        const reason =
          "Supervisor sessions run in a container, and Podman or Docker isn't installed on the orchestrator host";
        const read = (instanceFiles: ReadonlyArray<readonly [string, string]>) =>
          Effect.gen(function* () {
            const warnings: Array<unknown> = [];
            const view = yield* readConfigurationOf(
              instanceFiles,
              supervisorSandboxLayer(
                InstanceDirectory.make("/srv/instance"),
                InstanceId.make("6f0d2a8e-3b9c-4f1e-9a7d-2c5b8e1f4a3d"),
              ).pipe(Layer.provide(Layer.mergeAll(withoutContainerRuntime, NodeFileSystem.layer))),
            ).pipe(Effect.withLogger(warningsIn(warnings)));
            return { view, warnings };
          });

        const configured = yield* read(supervisorFiles);
        assert.strictEqual(configured.view.settings.supervisor?.unavailable, reason);
        assert.deepStrictEqual(
          configured.warnings.filter(
            (message) =>
              Array.isArray(message) &&
              message[0] === "The configured supervisor is unavailable on this orchestrator",
          ),
          [["The configured supervisor is unavailable on this orchestrator", { reason }]],
        );

        // The instance starts without a supervisor too, and then nothing warns about it.
        const unset = yield* read(files);
        assert.isNull(unset.view.settings.supervisor);
        assert.notInclude(
          jsonKey(unset.warnings),
          "The configured supervisor is unavailable on this orchestrator",
        );
      }),
  );

  it.effect("shows the instance's coordinator and resolves Agents that don't set one to it", () =>
    Effect.gen(function* () {
      const view = yield* readConfigurationOf(eventsFiles);
      assert.strictEqual(view.settings.coordinator, "events");
      // Each limit shows its own setting.
      assert.strictEqual(view.settings.maxAttemptMinutes, 600);
      assert.strictEqual(view.settings.maxBackgroundWaitMinutes, 5);
      assert.isNull(view.settings.parentModel);
      const developer = view.agents.find(({ name }) => name === "developer");
      assert(developer !== undefined, "developer loads");
      assert.deepStrictEqual(
        [developer.coordinator, developer.resolvedCoordinator],
        [null, "events"],
      );
    }),
  );

  it.effect("reads in setup mode, where no Worker runs Attempts", () =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "usine-config-",
      });
      const root = InstanceDirectory.make(directory);
      yield* writeInstanceFiles(root, files);
      const view = yield* Effect.gen(function* () {
        const instance = yield* (yield* CurrentInstance).get;

        return yield* (yield* OperatorConfiguration).view(instance);
      }).pipe(
        Effect.provide(
          OperatorConfiguration.layer.pipe(
            Layer.provide(Layer.mergeAll(controls, labels, idleTriggersLayer, WorkerStatus.idle)),
            Layer.provideMerge(reloadableInstanceLayer(root)),
          ),
        ),
        Effect.flatMap(Schema.encodeEffect(ConfigurationView)),
      );
      assert.deepStrictEqual(
        view.workers.map(({ name, slots, prerequisites, harnesses }) => [
          name,
          slots,
          prerequisites,
          harnesses,
        ]),
        [
          ["local", null, null, []],
          ["eu-1", null, null, []],
        ],
      );
      assert.deepStrictEqual(view.removedWorkers, []);
      const [engine] = view.repositories;
      assert.isNull(engine?.declaredLabels[1]?.failure);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
