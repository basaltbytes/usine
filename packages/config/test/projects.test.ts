import { expect, it } from "@effect/vitest";
import { LoopName } from "@usine/core/loop";
import { Effect, Option, Schema } from "effect";
import { UsineConfig } from "../src/factory.ts";
import { InstancePath } from "../src/file.ts";
import { makeConfigParser } from "../src/parser.ts";
import { makeExpressionEngine } from "@usine/expression/marcbachmann-cel";
import { LoadedInstance } from "../src/instance/instance.ts";
import { LoopFile } from "../src/loop.ts";
import { Selector } from "../src/selector.ts";
import {
  boardRepositories,
  labelsForRepository,
  matchesLoop,
  migrateProjects,
  resolveLoopName,
} from "../src/project/operations.ts";
import { configurationDiff, configurationEntities } from "../src/configuration/entities.ts";

const parser = makeConfigParser(makeExpressionEngine());
const legacy = (repositories: ReadonlyArray<string>, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const config = Schema.decodeUnknownSync(UsineConfig)({
      version: 1,
      repos: repositories.map((name) => ({
        name,
        lanes: [{ name: "Ready", sources: [{ label: "ready" }] }],
      })),
    });
    const agent = yield* parser.parseAgentFile(
      InstancePath.make("agents/developer.md"),
      "---\nharness: codex\nmodel: gpt-6.1-sol\neffort: high\n---\nImplement.\n",
    );
    const loops = yield* Effect.forEach(names, (name) =>
      parser.parseLoopFile(
        InstancePath.make(`loops/${name}.md`),
        "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n---\nImplement.\n",
      ),
    );
    return new LoadedInstance({
      config,
      agents: [agent],
      loops,
      invalidAgents: [],
      quarantinedLoops: [],
      warnings: [],
    });
  });

it.effect("restricts a project's loops to its repositories before applying selectors", () =>
  Effect.gen(function* () {
    const original = yield* legacy(["acme/one", "acme/two", "acme/orphan"], ["implement"]);
    const config = Schema.decodeUnknownSync(UsineConfig)({
      version: 2,
      repos: original.config.repos.map(({ name }) => ({ name })),
      projects: [
        {
          id: "workspace",
          name: "Workspace",
          repositories: ["acme/one", "acme/two"],
          lanes: [{ name: "Ready", sources: [{ label: "ready" }] }],
        },
      ],
    });
    const source = original.loops[0];
    if (source === undefined) return yield* Effect.die("fixture loop missing");
    const loop = new LoopFile({ ...source, name: LoopName.make("workspace/implement") });
    const selected = new LoopFile({
      ...loop,
      selector: Option.some(Schema.decodeUnknownSync(Selector)({ repos: ["acme/two"] })),
    });
    expect(
      config.repos.filter((repo) => matchesLoop(config, loop, repo)).map(({ name }) => name),
    ).toEqual(["acme/one", "acme/two"]);
    expect(
      config.repos.filter((repo) => matchesLoop(config, selected, repo)).map(({ name }) => name),
    ).toEqual(["acme/two"]);
    expect(boardRepositories(config).map(({ name }) => name)).toEqual(["acme/one", "acme/two"]);
    for (const repo of boardRepositories(config))
      expect(labelsForRepository(config, repo.name).map(({ name }) => name)).toContain("ready");
    expect(
      () => new UsineConfig({ ...config, projects: [...config.projects, ...config.projects] }),
    ).toThrow();
  }),
);

it.effect(
  "migrates five loops and expands a shared loop into each selected project without changing its body",
  () =>
    Effect.gen(function* () {
      const five = yield* legacy(
        ["basaltbytes/usine"],
        ["start-dev", "review", "fix", "finish", "check"],
      );
      const migrated = migrateProjects(five);
      expect(migrated.config.projects.map(({ id }) => id)).toEqual(["basaltbytes-usine"]);
      expect(migrated.loops.map(({ name }) => name)).toEqual(
        five.loops.map(({ name }) => `basaltbytes-usine/${name}`),
      );
      expect(
        configurationDiff(
          configurationEntities(migrated),
          configurationEntities(migrateProjects(migrated)),
        ),
      ).toEqual([]);
      const two = migrateProjects(yield* legacy(["acme/one", "acme/two"], ["start-dev"]));
      expect(two.loops.map(({ name }) => name)).toEqual([
        "acme-one/start-dev",
        "acme-two/start-dev",
      ]);
      expect(two.loops.map(({ body }) => body)).toEqual(["Implement.\n", "Implement.\n"]);
      expect(Option.isNone(resolveLoopName(two.loops, LoopName.make("start-dev")))).toBe(true);
      expect(resolveLoopName(migrated.loops, LoopName.make("start-dev"))).toEqual(
        Option.some("basaltbytes-usine/start-dev"),
      );
    }),
);
