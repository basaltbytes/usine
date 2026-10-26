import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/config/label";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { InstanceDirectory } from "@usine/core/instance";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { LoopControl, LoopRuntimeState } from "@usine/engine/loop-control";
import {
  RepositoryLabelProjection,
  RepositoryLabelProjectionReader,
} from "@usine/engine/repository-label-projection";
import { fullPreflight, WorkerCapabilityError } from "@usine/executor";
import { DateTime, Effect, FileSystem, Layer, Option, Result, Schema } from "effect";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { idleTriggersLayer } from "../src/idle-triggers.ts";
import { LabelPreflightFinding } from "../src/label-reconciler.ts";
import { ConfigurationView, OperatorConfiguration } from "../src/operator/configuration.ts";
import { PollCycle, PollingTriggers } from "../src/polling-triggers.ts";
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
    destination: usine@eu-1
    root: /srv/usine
    identity_file: ~/.ssh/usine_worker
    gateway:
      domain: gw.internal
      destination: usine-gateway
      admin_token_env: USINE_GATEWAY_ADMIN_TOKEN
      llm_providers: [anthropic]
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
    Effect.succeed(
      repository === usine
        ? Option.some(
            Schema.decodeUnknownSync(RepositoryLabelProjection)({
              repository,
              labels: [
                { name: "Ready", color: "0e8a16", description: "Ready for an Agent" },
                { name: "review-findings", color: "d93f0b", description: null },
              ],
            }),
          )
        : Option.none(),
    ),
});

const finding = new LabelPreflightFinding({
  repository: usine,
  label: GitHubLabelName.make("ready-for-review"),
  errorTag: "GitHubApiError",
  message: "GitHub returned HTTP status 403",
});

const polling = Layer.succeed(PollingTriggers)({
  hint: () => Effect.void,
  poll: () => Effect.die("unused"),
  run: () => Effect.never,
  latest: Effect.succeed(
    Option.some(
      new PollCycle({
        repositories: 2,
        changedItems: 0,
        submissions: [],
        revokedRuns: 0,
        failures: [],
        preflightFindings: [finding],
        nextPollAt: Option.none(),
      }),
    ),
  ),
});

const controls = Layer.succeed(LoopControl)({
  isPaused: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  unpause: () => Effect.die("unused"),
  states: Effect.succeed([
    new LoopRuntimeState({ loop: LoopName.make("start-dev"), paused: true }),
    new LoopRuntimeState({ loop: LoopName.make("review"), paused: false }),
  ]),
});

const claudeLoggedOut = new WorkerCapabilityError({
  worker: local,
  capability: "harness-login",
  message: "Claude Code is not logged in on Worker local",
  cause: new HarnessUnavailableError({
    harness: "claude",
    capability: "login",
    message: "Claude Code is not logged in",
  }),
});

const workers = Layer.succeed(WorkerStatus)({
  slots: Effect.succeed([
    { worker: local, capacity: 2, leased: 1 },
    { worker: WorkerName.make("retired"), capacity: 0, leased: 1 },
  ]),
  queue: Effect.succeed([]),
  machines: Effect.succeed([]),
  provisioning: Effect.succeed([]),
  preflights: Effect.sync(() => {
    const codex = new BrainSpec({
      harness: "codex",
      model: ModelId.make("gpt-5.6-sol"),
      effort: "high",
    });
    const claude = new BrainSpec({
      harness: "claude",
      model: ModelId.make("claude-opus-4-1"),
      effort: "xhigh",
    });
    const started = recordPreflight(
      unchecked(local),
      [codex],
      startedAt,
      Result.succeed(fullPreflight),
    );
    return [
      recordPreflight(
        started,
        [codex, claude],
        DateTime.addDuration(startedAt, "1 hour"),
        Result.fail(claudeLoggedOut),
      ),
    ];
  }),
});

const readConfiguration = Effect.gen(function* () {
  const root = InstanceDirectory.make(
    yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "usine-config-" }),
  );
  yield* writeInstanceFiles(root, files);
  return yield* Effect.gen(function* () {
    const instance = yield* (yield* CurrentInstance).get;
    return yield* (yield* OperatorConfiguration).view(instance);
  }).pipe(
    Effect.provide(
      OperatorConfiguration.layer.pipe(
        Layer.provide(Layer.mergeAll(controls, labels, polling, workers)),
      ),
    ),
    Effect.provide(reloadableInstanceLayer(root)),
    Effect.map(Schema.encodeSync(ConfigurationView)),
  );
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

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

      const review = byName.get(LoopName.make("review"));
      assert(review !== undefined, "review is loaded");
      assert.deepStrictEqual(review.selector, { repos: null, tags: ["engine"] });
      assert.deepStrictEqual(review.repositories, [usine]);
      assert.strictEqual(review.permissions, "read");
      assert.strictEqual(review.priority, 2);
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
      assert.strictEqual(onSsh.destination, "usine@eu-1");
      assert.strictEqual(onSsh.root, "/srv/usine");
      assert.strictEqual(onSsh.identityFile, "~/.ssh/usine_worker");
      assert.isNull(onSsh.port);
      assert.isNull(onSsh.slots);
      assert.isNull(onSsh.prerequisites);
      assert.deepStrictEqual(onSsh.gateway, {
        domain: "gw.internal",
        destination: "usine-gateway",
        adminPort: 7070,
        adminTokenEnv: "USINE_GATEWAY_ADMIN_TOKEN",
        llmProviders: ["anthropic"],
      });
      assert.deepStrictEqual(view.removedWorkers, [{ name: "retired", running: 1 }]);

      const encoded = JSON.stringify(view);
      assert.include(encoded, "USINE_GATEWAY_ADMIN_TOKEN");
      assert.notInclude(encoded, '"adminToken"');
    }),
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
      assert.deepStrictEqual(
        forReview.label.failure,
        Schema.encodeSync(LabelPreflightFinding)(finding),
      );
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
        parentModel: "gpt-5.6-sol",
        parentEffort: null,
        operator: "PhilDL",
        webhooks: "endpoint",
        webhooksPublicUrl: "https://factory.example/webhooks",
        tracing: { otlpUrl: "http://localhost:4318/v1/traces", serviceName: "usine" },
      });
    }),
  );

  it.effect("reads in setup mode, where no Worker runs Attempts", () =>
    Effect.gen(function* () {
      const root = InstanceDirectory.make(
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "usine-config-" }),
      );
      yield* writeInstanceFiles(root, files);
      const view = yield* Effect.gen(function* () {
        const instance = yield* (yield* CurrentInstance).get;
        return yield* (yield* OperatorConfiguration).view(instance);
      }).pipe(
        Effect.provide(
          OperatorConfiguration.layer.pipe(
            Layer.provide(Layer.mergeAll(controls, labels, idleTriggersLayer, WorkerStatus.idle)),
          ),
        ),
        Effect.provide(reloadableInstanceLayer(root)),
        Effect.map(Schema.encodeSync(ConfigurationView)),
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
