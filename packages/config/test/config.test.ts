import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Instance } from "@usine/core";
import { MarcbachmannCelLayer } from "@usine/expression";
import { Effect, Layer, Option, Schema } from "effect";
import {
  ConfigParser,
  InstanceFolder,
  InstancePath,
  ManagedRepo,
  YamlEdit,
  matchesSelector,
  updateFrontmatter,
  updateYaml,
} from "../src/index.ts";

const parserLayer = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
const instanceFolderLayer = InstanceFolder.layer.pipe(
  Layer.provide(Layer.mergeAll(parserLayer, NodeFileSystem.layer, NodePath.layer)),
);
const acceptanceRoot = Instance.Directory.make(
  decodeURIComponent(new URL("./fixtures/acceptance", import.meta.url).pathname),
);
const invalidFactoryRoot = Instance.Directory.make(
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
      expect(config.webhooks.mode).toBe("off");
      expect(Option.isNone(config.operator)).toBe(true);

      const configuredWorker = yield* parser.parseUsineYaml(
        InstancePath.make("usine.yaml"),
        [
          "version: 1",
          "repos: []",
          "settings:",
          "  poll_interval: 30",
          "workers:",
          "  - name: remote",
          "    kind: exe.dev",
          "  - name: fast",
          "    kind: local",
          "    max_concurrent_attempts: 2",
        ].join("\n"),
      );
      expect(configuredWorker.settings.pollInterval).toBe(30);
      expect(configuredWorker.workers[0]?.maxConcurrentAttempts).toBe(1);
      expect(configuredWorker.workers[1]?.maxConcurrentAttempts).toBe(2);

      const failure = yield* parser
        .parseUsineYaml(InstancePath.make("usine.yaml"), "version: 1\nrepos: []\nenabled: true\n")
        .pipe(Effect.flip);
      expect(failure.stage).toBe("schema");
      expect(failure.message).toContain('["enabled"]');
    }).pipe(Effect.provide(parserLayer)),
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
});

describe("InstanceFolder", () => {
  it.effect("loads the three acceptance loops and quarantines broken siblings", () =>
    Effect.gen(function* () {
      const folder = yield* InstanceFolder;
      const loaded = yield* folder.load(acceptanceRoot);

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
      expect(loaded.quarantinedLoops[1]?.error.message).toBe("Unknown agent: ghost");
      expect(loaded.agents).toHaveLength(2);
      expect(loaded.invalidAgents).toHaveLength(0);
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
