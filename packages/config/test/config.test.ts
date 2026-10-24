import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { InstanceDirectory } from "@usine/core/instance";
import { type Environment, ExpressionEngine, Source } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, Layer, Logger, Option, Schema } from "effect";
import { InstanceFolder } from "../src/instance-folder.ts";
import { InstancePath } from "../src/file.ts";
import { LoadedInstance } from "../src/instance/instance.ts";
import { loopReferenceFailure, referenceIndex } from "../src/instance/references.ts";
import { ManagedRepo } from "../src/factory.ts";
import { ConfigParser } from "../src/parser.ts";
import { issueEnvironment, pullRequestEnvironment } from "../src/payload-slices.ts";
import { matchesSelector } from "../src/selector.ts";
import { updateFrontmatter, updateYaml, YamlEdit } from "../src/yaml/writer.ts";

const parserLayer = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
const instanceFolderLayer = InstanceFolder.layer.pipe(
  Layer.provide(Layer.mergeAll(parserLayer, NodeFileSystem.layer, NodePath.layer)),
);
const acceptanceRoot = InstanceDirectory.make(
  decodeURIComponent(new URL("./fixtures/acceptance", import.meta.url).pathname),
);
const invalidFactoryRoot = InstanceDirectory.make(
  decodeURIComponent(new URL("./fixtures/invalid-factory", import.meta.url).pathname),
);

describe("ConfigParser", () => {
  it.effect("applies usine.yaml defaults and rejects unknown keys", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const config = yield* parser.parseUsineYaml(
        InstancePath.make("usine.yaml"),
        "version: 1\nrepos: []\nsettings: {}\n",
      );

      expect(config.settings.pollInterval).toBe(60);
      expect(config.settings.maxChildren).toBe(4);
      expect(config.workers).toHaveLength(1);
      expect(config.workers[0]?.name).toBe("local");
      expect(config.repos).toEqual([]);
      expect(config.labels).toEqual([]);
      expect(config.webhooks.mode).toBe("off");
      expect(Option.isNone(config.operator)).toBe(true);

      const configuredWorker = yield* parser.parseUsineYaml(
        InstancePath.make("usine.yaml"),
        [
          "version: 1",
          "repos: []",
          "settings:",
          "  poll_interval: 30",
          "  max_children: 2",
          "workers:",
          "  - name: remote",
          "    kind: exe.dev",
          "  - name: fast",
          "    kind: local",
          "    max_concurrent_attempts: 2",
        ].join("\n"),
      );
      expect(configuredWorker.settings.pollInterval).toBe(30);
      expect(configuredWorker.settings.maxChildren).toBe(2);
      expect(configuredWorker.workers[0]?.maxConcurrentAttempts).toBe(1);
      expect(configuredWorker.workers[1]?.maxConcurrentAttempts).toBe(2);

      const noWorkers = yield* parser
        .parseUsineYaml(InstancePath.make("usine.yaml"), "version: 1\nrepos: []\nworkers: []\n")
        .pipe(Effect.flip);
      expect(noWorkers.stage).toBe("schema");

      const failure = yield* parser
        .parseUsineYaml(InstancePath.make("usine.yaml"), "version: 1\nrepos: []\nenabled: true\n")
        .pipe(Effect.flip);
      expect(failure.stage).toBe("schema");
      expect(failure.message).toContain('["enabled"]');
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("parses the tracing block, defaults service_name, and rejects other URLs", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const parse = (tracing: ReadonlyArray<string>) =>
        parser.parseUsineYaml(
          InstancePath.make("usine.yaml"),
          ["version: 1", "repos: []", ...tracing].join("\n"),
        );

      expect(Option.isNone((yield* parse([])).tracing)).toBe(true);
      const defaulted = Option.getOrNull(
        (yield* parse(["tracing:", "  otlp_url: http://localhost:4318/v1/traces"])).tracing,
      );
      expect(defaulted?.otlpUrl.href).toBe("http://localhost:4318/v1/traces");
      expect(defaulted?.serviceName).toBe("usine");
      const named = Option.getOrNull(
        (yield* parse([
          "tracing:",
          "  otlp_url: https://collector.internal/v1/traces",
          "  service_name: usine-eu",
        ])).tracing,
      );
      expect(named?.serviceName).toBe("usine-eu");

      for (const tracing of [
        ["tracing: {}"],
        ["tracing:", "  otlp_url: localhost:4318"],
        ["tracing:", "  otlp_url: grpc://localhost:4317"],
        ["tracing:", "  otlp_url: http://localhost:4318/v1/traces", '  service_name: " "'],
        ["tracing:", "  otlpUrl: http://localhost:4318/v1/traces"],
      ]) {
        const failure = yield* parse(tracing).pipe(Effect.flip);
        expect(failure.stage).toBe("schema");
      }
      for (const otlpUrl of [
        "https://user:token@collector.example/v1/traces",
        "https://collector.example/v1/traces?api_key=token",
      ]) {
        const failure = yield* parse(["tracing:", `  otlp_url: ${otlpUrl}`]).pipe(Effect.flip);
        expect(failure.message).toContain("authenticate in a collector next to usine up");
      }
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("parses an ssh Worker's address and refuses it on other kinds", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const parse = (workers: ReadonlyArray<string>) =>
        parser.parseUsineYaml(
          InstancePath.make("usine.yaml"),
          ["version: 1", "repos: []", "workers:", ...workers].join("\n"),
        );
      const configured = yield* parse([
        "  - name: eu-one",
        "    kind: ssh",
        "    destination: usine@203.0.113.7",
        "    identity_file: ~/.ssh/usine_worker",
        "    port: 2222",
        "    root: /home/usine/.usine",
        "    max_concurrent_attempts: 2",
        "  - name: eu-two",
        "    kind: ssh",
        "    destination: eu-two",
        "    root: /srv/usine",
        "    gateway:",
        "      domain: gw.internal",
        "      destination: usine-gateway",
        "      admin_port: 7071",
        "      admin_token_env: USINE_GATEWAY_ADMIN_TOKEN",
        "      llm_providers: [anthropic]",
      ]);
      const [first, second] = configured.workers;
      expect(first?.kind).toBe("ssh");
      expect(second?.kind).toBe("ssh");
      if (first?.kind !== "ssh" || second?.kind !== "ssh") return;
      expect(first.destination).toBe("usine@203.0.113.7");
      expect(Option.getOrNull(first.identityFile)).toBe("~/.ssh/usine_worker");
      expect(Option.getOrNull(first.port)).toBe(2222);
      expect(first.root).toBe("/home/usine/.usine");
      expect(first.maxConcurrentAttempts).toBe(2);
      expect(Option.isNone(first.gateway)).toBe(true);
      expect(Option.isNone(second.identityFile) && Option.isNone(second.port)).toBe(true);
      const gateway = Option.getOrNull(second.gateway);
      expect(gateway?.domain).toBe("gw.internal");
      expect(gateway?.destination).toBe("usine-gateway");
      expect(gateway?.adminPort).toBe(7071);
      expect(gateway?.adminTokenEnv).toBe("USINE_GATEWAY_ADMIN_TOKEN");
      expect(gateway?.llmProviders).toEqual(["anthropic"]);

      const gatewayOf = (lines: ReadonlyArray<string>) => [
        "  - name: eu",
        "    kind: ssh",
        "    destination: eu",
        "    root: /srv",
        "    gateway:",
        ...lines.map((line) => `      ${line}`),
      ];
      const valid = [
        "domain: gw.internal",
        "destination: root@203.0.113.30",
        "admin_token_env: GATEWAY_TOKEN",
      ];
      const withDefaults = yield* parse(gatewayOf(valid));
      const [only] = withDefaults.workers;
      expect(
        only?.kind === "ssh" &&
          Option.map(only.gateway, ({ adminPort, llmProviders }) => ({ adminPort, llmProviders })),
      ).toEqual(Option.some({ adminPort: 7070, llmProviders: [] }));

      for (const workers of [
        gatewayOf([...valid, "llm_providers: [openai]"]),
        gatewayOf(["domain: GW.internal", ...valid.slice(1)]),
        gatewayOf([valid[0] ?? "", "destination: -oProxyCommand=sh", valid[2] ?? ""]),
        gatewayOf([valid[0] ?? "", valid[2] ?? ""]),
        gatewayOf([...valid, "admin_port: 0"]),
        gatewayOf([...valid.slice(0, 2), "admin_token_env: sk-ant-0123"]),
        gatewayOf([...valid, "admin_token: secret"]),
        ["  - name: here", "    kind: local", "    root: /srv/usine"],
        ["  - name: eu", "    kind: ssh", "    root: /srv/usine"],
        ["  - name: eu", "    kind: ssh", "    destination: -oProxyCommand=sh", "    root: /srv"],
        ["  - name: eu", "    kind: ssh", "    destination: eu", "    root: srv/usine"],
        ["  - name: eu", "    kind: ssh", "    destination: eu", "    root: /srv/usine/"],
        ["  - name: eu", "    kind: ssh", "    destination: eu", "    root: /srv", "    port: 0"],
        ["  - name: eu", "    kind: ssh", "    destination: eu", "    root: /srv", "    user: x"],
      ]) {
        const failure = yield* parse(workers).pipe(Effect.flip);
        expect(failure.stage).toBe("schema");
      }
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("parses declared labels and rejects invalid label declarations", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const configured = yield* parser.parseUsineYaml(
        InstancePath.make("usine.yaml"),
        [
          "version: 1",
          "labels:",
          "  - name: ready-for-agent",
          "    color: A2EEEF",
          "    description: Ready for an agent to claim",
          "  - name: ready-for-review",
          "repos: []",
        ].join("\n"),
      );

      expect(configured.labels.map(({ name }) => name)).toEqual([
        "ready-for-agent",
        "ready-for-review",
      ]);
      expect(Option.getOrNull(configured.labels[0]?.color ?? Option.none())).toBe("A2EEEF");
      expect(Option.getOrNull(configured.labels[0]?.description ?? Option.none())).toBe(
        "Ready for an agent to claim",
      );
      expect(Option.isNone(configured.labels[1]?.color ?? Option.none())).toBe(true);

      for (const source of [
        "version: 1\nlabels: [{ name: '   ' }]\nrepos: []\n",
        "version: 1\nlabels: [{ name: ' ready ' }]\nrepos: []\n",
        `version: 1\nlabels: [{ name: ${"x".repeat(51)} }]\nrepos: []\n`,
        "version: 1\nlabels: [{ name: ready, color: '#a2eeef' }]\nrepos: []\n",
        "version: 1\nlabels: [{ name: ready, colour: a2eeef }]\nrepos: []\n",
        `version: 1\nlabels: [{ name: ready, description: ${"x".repeat(101)} }]\nrepos: []\n`,
      ]) {
        const failure = yield* parser
          .parseUsineYaml(InstancePath.make("usine.yaml"), source)
          .pipe(Effect.flip);
        expect(failure.stage).toBe("schema");
      }
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("rejects case-only duplicate label declarations", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const failure = yield* parser
        .parseUsineYaml(
          InstancePath.make("usine.yaml"),
          "version: 1\nlabels: [{ name: Ready }, { name: ready }]\nrepos: []\n",
        )
        .pipe(Effect.flip);

      expect(failure.stage).toBe("schema");
      expect(failure.message).toContain("unique GitHub label names");
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("rejects repository names and lane labels that differ only in case", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const registry = yield* parser
        .parseUsineYaml(
          InstancePath.make("usine.yaml"),
          "version: 1\nrepos: [{ name: Acme/Widgets }, { name: acme/widgets }]\n",
        )
        .pipe(Effect.flip);
      expect(registry.stage).toBe("schema");
      expect(registry.message).toContain("unique repository names, ignoring case");

      const lanes = yield* parser
        .parseUsineYaml(
          InstancePath.make("usine.yaml"),
          [
            "version: 1",
            "repos:",
            "  - name: acme/widgets",
            "    lanes:",
            "      - name: Ready",
            "        sources: [{ label: Ready }]",
            "      - name: Also ready",
            "        sources: [{ label: ready }]",
          ].join("\n"),
        )
        .pipe(Effect.flip);
      expect(lanes.stage).toBe("schema");
      expect(lanes.message).toContain("each lane source in only one lane");

      const selector = yield* parser
        .parseLoopFile(
          InstancePath.make("loops/widgets.md"),
          "---\ntrigger:\n  on: issue\n  if: 'true'\nselector:\n  repos: [Acme/Widgets, acme/widgets]\nstep: implement\nagent: developer\n---\nWork on the Item.",
        )
        .pipe(Effect.flip);
      expect(selector.stage).toBe("schema");
      expect(selector.message).toContain("unique repository names, ignoring case");
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("warns when a Lane or label-related trigger literal is undeclared", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const config = yield* parser.parseUsineYaml(
        InstancePath.make("usine.yaml"),
        [
          "version: 1",
          "labels: [{ name: declared }]",
          "repos:",
          "  - name: basaltbytes/usine",
          "    lanes:",
          "      - name: Ready",
          "        sources: [{ label: missing-lane }]",
        ].join("\n"),
      );
      const loop = yield* parser.parseLoopFile(
        InstancePath.make("loops/watch-label.md"),
        [
          "---",
          "trigger:",
          "  on: issue",
          "  if: item.labels.nodes.exists(label, label.name == 'missing-trigger' && item.state == 'OPEN')",
          "agent: developer",
          "---",
          "Handle it.",
        ].join("\n"),
      );
      const chainedMacroLoop = yield* parser.parseLoopFile(
        InstancePath.make("loops/watch-chained-label.md"),
        [
          "---",
          "trigger:",
          "  on: issue",
          "  if: item.labels.nodes.map(label, label.name).exists(name, name == 'missing-chained-trigger')",
          "agent: developer",
          "---",
          "Handle it.",
        ].join("\n"),
      );

      const conditionalLoop = yield* parser.parseLoopFile(
        InstancePath.make("loops/watch-conditional-label.md"),
        [
          "---",
          "trigger:",
          "  on: issue",
          "  if: \"item.labels.nodes.exists(label, label.name == (item.state == 'OPEN' ? 'declared' : 'missing-conditional-trigger'))\"",
          "agent: developer",
          "---",
          "Handle it.",
        ].join("\n"),
      );

      const warnings = yield* parser.configWarnings(config, [
        loop,
        chainedMacroLoop,
        conditionalLoop,
      ]);
      expect(warnings).toEqual([
        expect.objectContaining({
          _tag: "UndeclaredLaneLabelWarning",
          repository: "basaltbytes/usine",
          lane: "Ready",
          label: "missing-lane",
        }),
        expect.objectContaining({
          _tag: "UndeclaredTriggerLabelWarning",
          loop: "watch-label",
          label: "missing-trigger",
        }),
        expect.objectContaining({
          _tag: "UndeclaredTriggerLabelWarning",
          loop: "watch-chained-label",
          label: "missing-chained-trigger",
        }),
        expect.objectContaining({
          _tag: "UndeclaredTriggerLabelWarning",
          loop: "watch-conditional-label",
          label: "missing-conditional-trigger",
        }),
      ]);
      expect(warnings.some((warning) => warning.label === "OPEN")).toBe(false);
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("parses parent_effort in settings and agent frontmatter as the Effort scale", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const config = yield* parser.parseUsineYaml(
        InstancePath.make("usine.yaml"),
        "version: 1\nrepos: []\nsettings:\n  parent_model: openai-codex/gpt-5.6-terra\n  parent_effort: medium\n",
      );
      expect(Option.getOrNull(config.settings.parentEffort)).toBe("medium");

      const unset = yield* parser.parseUsineYaml(
        InstancePath.make("usine.yaml"),
        "version: 1\nrepos: []\n",
      );
      expect(Option.isNone(unset.settings.parentEffort)).toBe(true);

      const invalid = yield* parser
        .parseUsineYaml(
          InstancePath.make("usine.yaml"),
          "version: 1\nrepos: []\nsettings:\n  parent_effort: extreme\n",
        )
        .pipe(Effect.flip);
      expect(invalid.stage).toBe("schema");
      expect(invalid.message).toContain("parent_effort");

      const agent = yield* parser.parseAgentFile(
        InstancePath.make("agents/developer.md"),
        "---\nharness: codex\nmodel: gpt-5.6-sol\neffort: xhigh\nparent_effort: low\n---\nPersona body.",
      );
      expect(Option.getOrNull(agent.parentEffort)).toBe("low");

      const inheriting = yield* parser.parseAgentFile(
        InstancePath.make("agents/developer.md"),
        "---\nharness: codex\nmodel: gpt-5.6-sol\neffort: xhigh\n---\nPersona body.",
      );
      expect(Option.isNone(inheriting.parentEffort)).toBe(true);

      const badAgent = yield* parser
        .parseAgentFile(
          InstancePath.make("agents/developer.md"),
          "---\nharness: codex\nmodel: gpt-5.6-sol\neffort: xhigh\nparent_effort: extreme\n---\nPersona body.",
        )
        .pipe(Effect.flip);
      expect(badAgent.stage).toBe("schema");
      expect(badAgent.message).toContain("parent_effort");
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("parses one exclusive per-repository lane map", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const configured = yield* parser.parseUsineYaml(
        InstancePath.make("usine.yaml"),
        [
          "version: 1",
          "repos:",
          "  - name: basaltbytes/usine",
          "    lanes:",
          "      - name: Ready",
          "        sources:",
          "          - label: ready-for-agent",
          "      - name: In review",
          "        sources:",
          "          - state: pr-open",
          "          - label: ready-for-review",
        ].join("\n"),
      );

      expect(configured.repos[0]?.lanes.map(({ name }) => name)).toEqual(["Ready", "In review"]);

      const duplicate = yield* parser
        .parseUsineYaml(
          InstancePath.make("usine.yaml"),
          [
            "version: 1",
            "repos:",
            "  - name: basaltbytes/usine",
            "    lanes:",
            "      - name: Ready",
            "        sources: [{ label: ready-for-agent }]",
            "      - name: Also ready",
            "        sources: [{ label: ready-for-agent }]",
          ].join("\n"),
        )
        .pipe(Effect.flip);
      expect(duplicate.stage).toBe("schema");
      expect(duplicate.message).toContain("each lane source in only one lane");
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("defaults Item rounds to three and accepts only positive snake_case max_cycles", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const source = (field: string) =>
        `---\ntrigger:\n  on: pr\n  if: 'true'\nagent: reviewer\n${field}---\nReview the Item.`;
      const parse = (field: string) =>
        parser.parseLoopFile(InstancePath.make("loops/review.md"), source(field));
      expect((yield* parse("")).maxCycles).toBe(3);
      expect((yield* parse("max_cycles: 5\n")).maxCycles).toBe(5);
      for (const invalid of ["max_cycles: 0\n", "max_cycles: 1.5\n", "maxCycles: 5\n"]) {
        expect((yield* parse(invalid).pipe(Effect.flip)).stage).toBe("schema");
      }
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("defaults Loop permissions to write and accepts only read or write", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const source = (field: string) =>
        `---\ntrigger:\n  on: pr\n  if: 'true'\nagent: reviewer\n${field}---\nReview the Item.`;
      const parse = (field: string) =>
        parser.parseLoopFile(InstancePath.make("loops/review.md"), source(field));
      expect((yield* parse("")).permissions).toBe("write");
      expect((yield* parse("permissions: read\n")).permissions).toBe("read");
      expect((yield* parse("permissions: write\n")).permissions).toBe("write");
      for (const invalid of [
        "permissions: admin\n",
        "permissions: { contents: read }\n",
        "permission: read\n",
      ]) {
        const failure = yield* parse(invalid).pipe(Effect.flip);
        expect(failure.stage).toBe("schema");
        expect(failure.message).toContain("permission");
      }
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("exposes pull request mergeability to pr trigger expressions", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const source = (condition: string) =>
        `---\ntrigger:\n  on: pr\n  if: ${condition}\nagent: finisher\n---\nRebase the branch.`;
      const parse = (condition: string) =>
        parser.parseLoopFile(InstancePath.make("loops/rebase-pr.md"), source(condition));
      const loop = yield* parse(
        '\'item.mergeable == "CONFLICTING" && item.mergeStateStatus != "UNKNOWN"\'',
      );
      expect(loop.trigger.on).toBe("pr");
      const issueFailure = yield* parser
        .parseLoopFile(
          InstancePath.make("loops/rebase-issue.md"),
          "---\ntrigger:\n  on: issue\n  if: 'item.mergeable == \"CONFLICTING\"'\nagent: finisher\n---\nNo.",
        )
        .pipe(Effect.flip);
      expect(issueFailure.stage).toBe("expression");
      expect(issueFailure.message).toContain("No such key: mergeable");
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("reads an unquoted boolean if: as the CEL literal and explains other values", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const parse = (trigger: string) =>
        parser.parseLoopFile(
          InstancePath.make("loops/always.md"),
          `---\ntrigger:\n${trigger}agent: developer\n---\nDo the work.`,
        );
      expect((yield* parse("  on: issue\n  if: true\n")).trigger.if).toBe("true");
      expect((yield* parse("  on: pr\n  if: false\n")).trigger.if).toBe("false");
      const schedule = yield* parse("  on: schedule\n  if: true\n  cron: '0 9 * * 1'\n");
      expect(schedule.trigger.if).toBe("true");
      for (const value of ["3", "[ready]", "", "{ state: OPEN }"]) {
        const failure = yield* parse(`  on: issue\n  if: ${value}\n`).pipe(Effect.flip);
        expect(failure.stage).toBe("schema");
        expect(failure.message).toContain(
          "Expected a CEL expression. Quote the value so that YAML reads it as a string.",
        );
      }
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("declares the GitHub payload fields that can be null as nullable", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const holds = (environment: Environment, item: Schema.JsonObject, expression: string) =>
        engine.evaluateBoolean(Source.make(expression), environment, {
          repo: { name: "basaltbytes/usine", owner: "basaltbytes", url: "https://example.test" },
          item,
        });
      const issue = {
        stateReason: null,
        closedAt: null,
        author: null,
        issueType: null,
        milestone: null,
        comments: { totalCount: 1, nodes: [{ author: null, body: "", createdAt: "" }] },
      };
      expect(
        yield* holds(
          issueEnvironment,
          issue,
          "item.stateReason == null && item.closedAt == null && item.author == null && " +
            "item.issueType == null && item.milestone == null && !has(item.milestone.title) && " +
            "item.comments.nodes.all(comment, comment.author == null)",
        ),
      ).toBe(true);
      const pullRequest = {
        mergedAt: null,
        author: null,
        reviewDecision: null,
        statusCheckRollup: null,
        // A team review request has no `login`; a deleted reviewer is null.
        reviewRequests: {
          totalCount: 2,
          nodes: [{ requestedReviewer: {} }, { requestedReviewer: null }],
        },
        reviews: {
          totalCount: 1,
          nodes: [{ author: null, state: "COMMENTED", body: "", submittedAt: null, commit: null }],
        },
        reviewThreads: {
          totalCount: 1,
          nodes: [
            {
              isResolved: false,
              isOutdated: false,
              path: "a.ts",
              comments: { totalCount: 1, nodes: [{ author: null, body: "" }] },
            },
          ],
        },
        comments: { totalCount: 1, nodes: [{ author: null, body: "", createdAt: "" }] },
      };
      expect(
        yield* holds(
          pullRequestEnvironment,
          pullRequest,
          'item.mergedAt == null && item.author == null && item.reviewDecision != "APPROVED" && ' +
            "item.statusCheckRollup == null && " +
            "item.reviewRequests.nodes.all(request, request.requestedReviewer == null || " +
            "request.requestedReviewer.login == null) && " +
            "item.reviews.nodes.all(review, review.author == null && review.submittedAt == null && " +
            "review.commit == null) && " +
            "item.reviewThreads.nodes.all(thread, thread.comments.nodes.all(comment, comment.author == null)) && " +
            "item.comments.nodes.all(comment, comment.author == null)",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("rejects enabled in loop frontmatter instead of silently accepting it", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const failure = yield* parser
        .parseLoopFile(
          InstancePath.make("loops/disabled.md"),
          [
            "---",
            "enabled: false",
            "trigger:",
            "  on: issue",
            "  if: 'true'",
            "agent: developer",
            "---",
            "Do the work.",
          ].join("\n"),
        )
        .pipe(Effect.flip);

      expect(failure.stage).toBe("schema");
      expect(failure.message).toContain('["enabled"]');
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("rejects cron ranges with an empty bound instead of coercing it to zero", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const failure = yield* parser
        .parseLoopFile(
          InstancePath.make("loops/bad-schedule.md"),
          [
            "---",
            "trigger:",
            "  on: schedule",
            "  if: 'true'",
            "  cron: '-1 * * * *'",
            "agent: developer",
            "---",
            "Run scheduled maintenance.",
          ].join("\n"),
        )
        .pipe(Effect.flip);

      expect(failure.stage).toBe("schema");
      expect(failure.message).toContain("valid five-field cron expression");
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("rejects a schedule loop whose tz is not an IANA time-zone name", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const failure = yield* parser
        .parseLoopFile(
          InstancePath.make("loops/bad-time-zone.md"),
          [
            "---",
            "trigger:",
            "  on: schedule",
            "  if: 'true'",
            "  cron: '0 9 * * *'",
            "  tz: 'Mars/Olympus_Mons'",
            "agent: developer",
            "---",
            "Run scheduled maintenance.",
          ].join("\n"),
        )
        .pipe(Effect.flip);

      expect(failure.stage).toBe("schema");
      expect(failure.message).toContain("IANA time-zone name");
    }).pipe(Effect.provide(parserLayer)),
  );

  it.effect(
    "parses a schedule loop, defaulting tz to UTC and checking against the tick slice",
    () =>
      Effect.gen(function* () {
        const parser = yield* ConfigParser;
        const loop = yield* parser.parseLoopFile(
          InstancePath.make("loops/weekly-sweep.md"),
          [
            "---",
            "trigger:",
            "  on: schedule",
            "  if: item.tick.cron != ''",
            "  cron: '0 9 * * 1'",
            "agent: developer",
            "---",
            "Sweep the backlog for the tick at {{ item.tick.scheduledAt }}.",
          ].join("\n"),
        );

        expect(loop.trigger.on).toBe("schedule");
        if (loop.trigger.on !== "schedule") return;
        expect(loop.trigger.cron).toBe("0 9 * * 1");
        expect(loop.trigger.tz).toBe("UTC");
      }).pipe(Effect.provide(parserLayer)),
  );

  it.effect("fails a loop whose prompt leaves an interpolation unclosed", () =>
    Effect.gen(function* () {
      const parser = yield* ConfigParser;
      const failure = yield* parser
        .parseLoopFile(
          InstancePath.make("loops/broken-prompt.md"),
          [
            "---",
            "trigger:",
            "  on: issue",
            "  if: 'true'",
            "agent: developer",
            "---",
            "Implement {{ item.title",
          ].join("\n"),
        )
        .pipe(Effect.flip);

      expect(failure.stage).toBe("expression");
      expect(failure.message).toContain("The prompt has an unclosed {{ at character");
    }).pipe(Effect.provide(parserLayer)),
  );
});

describe("InstanceFolder", () => {
  it.effect("loads the three acceptance loops and quarantines broken siblings", () =>
    Effect.gen(function* () {
      const folder = yield* InstanceFolder;
      const warnings: Array<unknown> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const loaded = yield* folder.load(acceptanceRoot).pipe(Effect.withLogger(logger));

      expect(warnings).toContainEqual([
        "Agent file left out of the roster; Loops that use it are quarantined",
        {
          file: "agents/intern.md",
          stage: "schema",
          message: loaded.invalidAgents[0]?.error.message,
        },
      ]);
      expect(warnings).toContainEqual([
        "Loop quarantined; it opens no Runs until its file is fixed",
        {
          file: "loops/unknown-agent.md",
          stage: "reference",
          message:
            'Unknown agent "ghost": agents/ghost.md is missing or invalid. Fix the agent file, or set agent to an existing agent.',
          expression: undefined,
        },
      ]);
      expect(warnings).toContainEqual([
        "Loop quarantined; it opens no Runs until its file is fixed",
        expect.objectContaining({
          file: "loops/broken-loop.md",
          stage: "expression",
          expression: 'item.labels.nodes.exists(label, label.nmae == "ready")',
        }),
      ]);

      expect(loaded.loops.map(({ name }) => name)).toEqual([
        "act-on-findings",
        "review-pr",
        "start-dev",
      ]);
      expect(loaded.quarantinedLoops.map(({ file }) => file)).toEqual([
        "loops/broken-loop.md",
        "loops/unknown-agent.md",
      ]);
      expect(loaded.quarantinedLoops[0]?.error.message).toContain("No such key: nmae");
      expect(Option.getOrNull(loaded.quarantinedLoops[0]?.error.expression ?? Option.none())).toBe(
        'item.labels.nodes.exists(label, label.nmae == "ready")',
      );
      expect(loaded.quarantinedLoops[1]?.error.message).toBe(
        'Unknown agent "ghost": agents/ghost.md is missing or invalid. Fix the agent file, or set agent to an existing agent.',
      );
      expect(loaded.agents.map(({ name }) => name)).toEqual(["developer", "reviewer"]);
      expect(loaded.invalidAgents.map(({ file }) => file)).toEqual(["agents/intern.md"]);
      expect(loaded.invalidAgents[0]?.error.stage).toBe("schema");
    }).pipe(Effect.provide(instanceFolderLayer)),
  );

  it.effect("makes a snapshot whose loop references an unrostered agent unconstructible", () =>
    Effect.gen(function* () {
      const folder = yield* InstanceFolder;
      const loaded = yield* folder.load(acceptanceRoot);

      expect(
        () =>
          new LoadedInstance({
            config: loaded.config,
            agents: [],
            invalidAgents: loaded.invalidAgents,
            loops: loaded.loops,
            quarantinedLoops: loaded.quarantinedLoops,
            warnings: loaded.warnings,
          }),
      ).toThrow();
    }).pipe(Effect.provide(instanceFolderLayer)),
  );

  it.effect("stops the instance load when usine.yaml is invalid", () =>
    Effect.gen(function* () {
      const folder = yield* InstanceFolder;
      const failure = yield* folder.load(invalidFactoryRoot).pipe(Effect.flip);

      expect(failure._tag).toBe("FactoryConfigError");
      expect(failure.file).toBe("usine.yaml");
      expect(failure.stage).toBe("schema");
    }).pipe(Effect.provide(instanceFolderLayer)),
  );

  it.effect("normalizes CEL bigint values while rendering prompt interpolation", () =>
    Effect.gen(function* () {
      const folder = yield* InstanceFolder;
      const parser = yield* ConfigParser;
      const loaded = yield* folder.load(acceptanceRoot);
      const loop = loaded.loops.find(({ name }) => name === "start-dev");
      expect(loop).toBeDefined();
      if (loop === undefined) return;

      const prompt = yield* parser.renderPrompt(loop, {
        repo: { name: "basaltbytes/usine", owner: "basaltbytes", url: "https://example.test" },
        item: { number: 25, title: "Instance-folder parsing" },
      });
      expect(prompt).toBe("Implement issue #25: Instance-folder parsing\n");
    }).pipe(Effect.provide(Layer.merge(instanceFolderLayer, parserLayer))),
  );

  it.effect("requires the repo and tag selector axes to match together", () =>
    Effect.gen(function* () {
      const folder = yield* InstanceFolder;
      const loaded = yield* folder.load(acceptanceRoot);
      const loop = loaded.loops.find(({ name }) => name === "start-dev");
      expect(loop).toBeDefined();
      if (loop === undefined) return;

      const repo = Schema.decodeUnknownSync(ManagedRepo);
      expect(
        matchesSelector(loop.selector, repo({ name: "basaltbytes/usine", tags: ["active"] })),
      ).toBe(true);
      expect(
        matchesSelector(loop.selector, repo({ name: "basaltbytes/usine", tags: ["dormant"] })),
      ).toBe(false);
      expect(
        matchesSelector(loop.selector, repo({ name: "basaltbytes/other", tags: ["active"] })),
      ).toBe(false);
      expect(matchesSelector(Option.none(), repo({ name: "basaltbytes/other", tags: [] }))).toBe(
        true,
      );
    }).pipe(Effect.provide(instanceFolderLayer)),
  );

  it.effect("resolves and matches selector repositories ignoring case", () =>
    Effect.gen(function* () {
      const folder = yield* InstanceFolder;
      const parser = yield* ConfigParser;
      const loaded = yield* folder.load(acceptanceRoot);
      const file = InstancePath.make("loops/mixed-case.md");
      const loop = yield* parser.parseLoopFile(
        file,
        "---\ntrigger:\n  on: issue\n  if: 'true'\nselector:\n  repos: [BasaltBytes/Usine]\nstep: implement\nagent: developer\n---\nWork on the Item.",
      );

      const references = referenceIndex(loaded.config, loaded.agents);
      expect(Option.isNone(loopReferenceFailure(file, loop, references))).toBe(true);
      expect(
        () =>
          new LoadedInstance({
            config: loaded.config,
            agents: loaded.agents,
            invalidAgents: loaded.invalidAgents,
            loops: [...loaded.loops, loop],
            quarantinedLoops: loaded.quarantinedLoops,
            warnings: loaded.warnings,
          }),
      ).not.toThrow();
      const repo = Schema.decodeUnknownSync(ManagedRepo);
      expect(matchesSelector(loop.selector, repo({ name: "basaltbytes/usine" }))).toBe(true);
      expect(matchesSelector(loop.selector, repo({ name: "basaltbytes/other" }))).toBe(false);
    }).pipe(Effect.provide(Layer.merge(instanceFolderLayer, parserLayer))),
  );
});

describe("YamlWriter", () => {
  it.effect("updates one YAML path while preserving comments and key order", () =>
    Effect.gen(function* () {
      const source = [
        "# keep this comment",
        "version: 1",
        "repos: []",
        "settings:",
        "  poll_interval: 60 # keep inline",
        "",
      ].join("\n");
      const updated = yield* updateYaml(
        InstancePath.make("usine.yaml"),
        source,
        new YamlEdit({ path: ["settings", "poll_interval"], value: 30 }),
      );

      expect(updated).toContain("# keep this comment");
      expect(updated).toContain("poll_interval: 30 # keep inline");
      expect(updated.indexOf("version:")).toBeLessThan(updated.indexOf("repos:"));
    }),
  );

  it.effect("updates frontmatter without touching the Markdown body", () =>
    Effect.gen(function* () {
      const source = [
        "---",
        "# authored note",
        "harness: codex",
        "model: gpt-5",
        "effort: medium",
        "---",
        "Persona body with # markdown.",
      ].join("\n");
      const updated = yield* updateFrontmatter(
        InstancePath.make("agents/developer.md"),
        source,
        new YamlEdit({ path: ["effort"], value: "high" }),
      );

      expect(updated).toContain("# authored note");
      expect(updated).toContain("effort: high");
      expect(updated.endsWith("Persona body with # markdown.")).toBe(true);
    }),
  );

  it.effect("retains CRLF newline style in standalone and frontmatter edits", () =>
    Effect.gen(function* () {
      const updatedYaml = yield* updateYaml(
        InstancePath.make("usine.yaml"),
        "version: 1\r\nrepos: []\r\n",
        new YamlEdit({ path: ["version"], value: 1 }),
      );
      expect(updatedYaml).toBe("version: 1\r\nrepos: []\r\n");

      const updatedMarkdown = yield* updateFrontmatter(
        InstancePath.make("agents/developer.md"),
        "---\r\nharness: codex\r\nmodel: gpt-5\r\neffort: medium\r\n---\r\nPersona body.",
        new YamlEdit({ path: ["effort"], value: "high" }),
      );
      expect(updatedMarkdown).toBe(
        "---\r\nharness: codex\r\nmodel: gpt-5\r\neffort: high\r\n---\r\nPersona body.",
      );
    }),
  );

  it.effect("does not treat a frontmatter-prefix line as the closing delimiter", () =>
    Effect.gen(function* () {
      const source = [
        "---",
        "harness: codex",
        "---not-a-delimiter: true",
        "effort: medium",
        "---",
        "Persona body.",
      ].join("\n");
      const updated = yield* updateFrontmatter(
        InstancePath.make("agents/developer.md"),
        source,
        new YamlEdit({ path: ["effort"], value: "high" }),
      );

      expect(updated).toContain('"---not-a-delimiter": true');
      expect(updated).toContain("effort: high");
      expect(updated.endsWith("Persona body.")).toBe(true);
    }),
  );
});
