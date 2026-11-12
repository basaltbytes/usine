import { AgentFile } from "../src/agent.ts";
import { Harness } from "@usine/core/agent/brain";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { migrateProjects } from "../src/project/operations.ts";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql";
import { assert, describe, expect, it } from "@effect/vitest";
import { InstanceDirectory } from "@usine/core/instance";
import { OperatorLogin } from "@usine/core/operator";
import { makeExpressionEngine, MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import {
  Context,
  DateTime,
  Effect,
  Equal,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { LoadedInstance } from "../src/instance/instance.ts";
import { ConfigParser, makeConfigParser } from "../src/parser.ts";
import { InstancePath } from "../src/file.ts";
import {
  commit,
  configurationDiff,
  configurationEntities,
  Configuration,
  ConfigurationChange,
  ConfigurationEntity,
  ConfigurationEntityId,
  ConfigurationEntityKey,
  ConfigurationRevision,
  ConfigurationRevisionNumber,
  ConfigurationStore,
  revertConfiguration,
  validateConfiguration,
} from "../src/configuration/store.ts";
import {
  ConfigurationFolder,
  formatConfigurationEntity,
  formatRevisionEntity,
  parseConfigurationEntity,
} from "../src/configuration/folder.ts";
import { replay } from "../src/configuration/commit.ts";
import { LoopJson } from "../src/configuration/entities.ts";
import { memoryConfigurationLayer } from "../src/configuration/memory.ts";
import { sqliteConfigurationLayer } from "../src/configuration/sqlite/store.ts";

const parser = makeConfigParser(makeExpressionEngine());
const parserLayer = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
const metadata = {
  actor: Option.some(OperatorLogin.make("operator")),
  message: Option.some("Initial configuration"),
  time: DateTime.makeUnsafe("2026-10-28T12:00:00Z"),
};
const zero = ConfigurationRevisionNumber.make(0);
const fixture = Effect.gen(function* () {
  const config = yield* parser.parseUsineYaml(
    InstancePath.make("usine.yaml"),
    `version: 1
operator: operator
repos:
  - name: acme/project
    tags: [app]
    lanes:
      - name: Ready
        sources: [{label: ready}]
labels:
  - name: ready
  - name: review
workers:
  - name: local
    kind: local
  - name: fallback
    kind: local
settings:
  poll_interval: 30
`,
  );
  const agent = yield* parser.parseAgentFile(
    InstancePath.make("agents/developer.md"),
    "---\nharness: codex\nmodel: gpt-6.1-sol\neffort: high\n---\nImplement the issue.\n",
  );
  const loop = yield* parser.parseLoopFile(
    InstancePath.make("loops/implement.md"),
    `---
trigger:
  on: issue
  if: >-
    item.number > 0 &&
    item.title != "This title makes the expression long enough for the YAML writer to fold it"
agent: developer
selector:
  repos: [acme/project]
  tags: [app]
---
Implement #{{ item.number }}.
`,
  );
  return LoadedInstance.make({
    config,
    agents: [agent],
    loops: [loop],
    warnings: [],
    invalidAgents: [],
    quarantinedLoops: [],
  });
});

const initialChanges = fixture.pipe(
  Effect.map(configurationEntities),
  Effect.map((entities) => configurationDiff([], entities)),
);
const decodeObject = Schema.decodeUnknownEffect(Schema.JsonObject);
const initialize = Effect.gen(function* () {
  const store = yield* ConfigurationStore;
  const changes = yield* initialChanges;
  return yield* store.commit({ expected: zero, changes, ...metadata });
});

describe("configuration domain without layers", () => {
  it.effect("refuses a Pi coding agent on an SSH worker before storing configuration", () =>
    Effect.gen(function* () {
      const instance = yield* fixture;
      const entities = configurationEntities(
        LoadedInstance.make({
          ...instance,
          agents: instance.agents.map((file) =>
            AgentFile.make({ ...file, harness: Harness.make("pi") }),
          ),
        }),
      ).map((entity) =>
        entity.key.kind === "worker"
          ? ConfigurationEntity.make({
              ...entity,
              value: {
                name: entity.key.identifier,
                kind: "ssh",
                destination: "worker.example",
                root: "/srv/usine",
              },
            })
          : entity,
      );
      const result = yield* commit(
        parser,
        Configuration.empty,
        zero,
        configurationDiff([], entities),
        metadata,
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ConfigurationInvalid");
        if (result.failure._tag === "ConfigurationInvalid") {
          expect(result.failure.problems).toHaveLength(2);
          for (const problem of result.failure.problems) {
            expect(problem.file).toBe("agents/developer.md");
            expect(problem.message).toContain("coding-agent at container: lacks container");
            expect(problem.message).toContain("Pi runs its tools in the orchestrator process");
          }
        }
      }
    }),
  );

  it.effect("replays a stored revision that adds an exe.dev worker", () =>
    Effect.gen(function* () {
      const changes = (yield* initialChanges).map((change) =>
        change.key.kind === "worker"
          ? ConfigurationChange.make({
              ...change,
              after: Option.some({ name: change.key.identifier, kind: "exe.dev" }),
            })
          : change,
      );
      const replayed = yield* replay(parser, Configuration.empty, zero, changes, metadata);
      expect(
        Option.map(replayed.configuration.instance, ({ config }) =>
          config.workers.map(({ kind }) => kind),
        ),
      ).toEqual(Option.some(["exe.dev", "exe.dev"]));
    }),
  );

  it.effect("loads a stored boxd worker that still sets identity_file", () =>
    Effect.gen(function* () {
      // A worker entity as releases before boxd's Exec transport stored it.
      const stored = {
        name: "boxd-pool",
        kind: "ssh",
        root: "/home/boxd/.usine",
        identity_file: "~/.ssh/usine_worker",
        provisioner: { provider: "boxd", token_env: "BOXD_API_KEY", snapshot: "usine-attempt" },
      };
      const instance = yield* fixture;
      const entities = configurationEntities(instance).map((entity) =>
        entity.key.kind === "worker" && entity.key.identifier === "fallback"
          ? ConfigurationEntity.make({
              ...entity,
              key: ConfigurationEntityKey.make({
                kind: "worker",
                identifier: ConfigurationEntityId.make("boxd-pool"),
              }),
              value: stored,
            })
          : entity,
      );
      const loaded = yield* validateConfiguration(parser, entities);
      const worker = loaded.config.workers.find(({ name }) => name === "boxd-pool");
      assert(worker?.kind === "ssh" && Option.isSome(worker.provisioner));
      expect(worker.provisioner.value.provider).toBe("boxd");
      expect(worker.identityFile).toStrictEqual(Option.some("~/.ssh/usine_worker"));
    }),
  );

  it.effect("loads a stored boxd worker that still sets reuse", () =>
    Effect.gen(function* () {
      // A worker entity as releases before boxd's single-use machines stored it.
      const stored = {
        name: "boxd-pool",
        kind: "ssh",
        root: "/home/boxd/.usine",
        provisioner: {
          provider: "boxd",
          token_env: "BOXD_API_KEY",
          snapshot: "usine-attempt",
          reuse: { attempts: 5, max_age: "2h" },
        },
      };
      const instance = yield* fixture;
      const entities = configurationEntities(instance).map((entity) =>
        entity.key.kind === "worker" && entity.key.identifier === "fallback"
          ? ConfigurationEntity.make({
              ...entity,
              key: ConfigurationEntityKey.make({
                kind: "worker",
                identifier: ConfigurationEntityId.make("boxd-pool"),
              }),
              value: stored,
            })
          : entity,
      );
      const loaded = yield* validateConfiguration(parser, entities);
      const worker = loaded.config.workers.find(({ name }) => name === "boxd-pool");
      assert(worker?.kind === "ssh" && Option.isSome(worker.provisioner));
      assert(worker.provisioner.value.provider === "boxd");
      expect(Option.isSome(worker.provisioner.value.reuse)).toBe(true);
    }),
  );

  it.effect("omits unchanged entities when adding or removing an entity before them", () =>
    Effect.gen(function* () {
      const fixtureInstance = yield* fixture;

      const original = configurationEntities(fixtureInstance);
      const added = ConfigurationEntity.make({
        key: ConfigurationEntityKey.make({
          kind: "label",
          identifier: ConfigurationEntityId.make("preferred"),
        }),
        value: { name: "preferred" },
      });
      const candidate = [added, ...original];
      expect(configurationDiff(original, candidate)).toEqual([
        ConfigurationChange.make({
          key: added.key,
          before: Option.none(),
          after: Option.some(added.value),
        }),
      ]);
      expect(configurationDiff(candidate, original)).toEqual([
        ConfigurationChange.make({
          key: added.key,
          before: Option.some(added.value),
          after: Option.none(),
        }),
      ]);
    }),
  );

  it.effect("ignores unordered entity positions and records worker-relative positions", () =>
    Effect.gen(function* () {
      const fixtureInstance = yield* fixture;

      const original = configurationEntities(fixtureInstance);
      const workers = original.filter(({ key }) => key.kind === "worker");
      const other = original.filter(({ key }) => key.kind !== "worker");
      expect(configurationDiff(original, [...other.reverse(), ...workers])).toEqual([]);
      const changes = configurationDiff(original, [...other, ...workers.reverse()]);
      expect(changes.map(({ key, position }) => [key.key, position])).toEqual([
        ["worker:fallback", 0],
        ["worker:local", 1],
      ]);
      expect(changes.every(({ before, after }) => Equal.equals(before, after))).toBe(true);
    }),
  );

  it.effect("rejects a stale commit and collects invalid entities without changing the input", () =>
    Effect.gen(function* () {
      const changes = yield* initialChanges;
      const first = yield* commit(parser, Configuration.empty, zero, changes, metadata);
      const stale = yield* commit(parser, first.configuration, zero, [], metadata).pipe(
        Effect.flip,
      );
      expect(stale._tag).toBe("StaleRevision");
      const invalid = changes
        .filter(({ key }) => key.kind === "agent" || key.kind === "worker")
        .map((change) =>
          ConfigurationChange.make({
            ...change,
            before: change.after,
            after: Option.some({ invalid: true }),
          }),
        );
      const failure = yield* commit(
        parser,
        first.configuration,
        first.configuration.number,
        invalid,
        metadata,
      ).pipe(Effect.flip);
      expect(failure._tag).toBe("ConfigurationInvalid");
      if (failure._tag === "ConfigurationInvalid")
        expect(failure.problems.length).toBeGreaterThanOrEqual(2);
      expect(first.configuration.number).toBe(1);
      const worker = changes.find(({ key }) => key.kind === "worker");
      if (worker === undefined) return yield* Effect.die("fixture has no worker");
      const normalized = yield* commit(
        parser,
        first.configuration,
        first.configuration.number,
        [
          ConfigurationChange.make({
            key: worker.key,
            before: worker.after,
            after: Option.some({ name: "local", kind: "local" }),
          }),
        ],
        metadata,
      );
      expect(normalized.revision.changes).toEqual([]);
    }),
  );
});

const adapters = [
  ["memory", memoryConfigurationLayer.pipe(Layer.provide(parserLayer))],
  [
    "sqlite",
    sqliteConfigurationLayer.pipe(
      Layer.provide(parserLayer),
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  ],
] as const;

for (const [name, layer] of adapters)
  describe(`${name} configuration store contract`, () => {
    it.effect("stores defaults and round-trips every entity kind without changes", () =>
      Effect.gen(function* () {
        const fixtureInstance = yield* fixture;
        const store = yield* ConfigurationStore;
        const folder = yield* ConfigurationFolder;
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const root = InstanceDirectory.make(directory);

        const canonical = configurationEntities(fixtureInstance);
        const initial = yield* initialChanges;
        const changes = yield* Effect.forEach(initial, (change) =>
          Effect.gen(function* () {
            if (change.key.kind !== "loop") return change;
            const after = yield* Effect.transposeOption(Option.map(change.after, decodeObject));
            return ConfigurationChange.make({
              ...change,
              after: Option.map(
                after,
                ({ maxCycles: _cycles, permissions: _permissions, ...fields }) => fields,
              ),
            });
          }),
        );
        const revision = yield* store.commit({ expected: zero, changes, ...metadata });
        expect(revision.changes).toEqual(configurationDiff([], canonical));
        const { instance } = yield* store.read;
        if (Option.isNone(instance)) return yield* Effect.die("configuration is uninitialized");
        const exportedInstance = yield* Effect.fromResult(migrateProjects(instance.value));
        yield* folder.export(root, exportedInstance);
        const reloadedInstance = yield* folder.load(root);
        const imported = configurationEntities(reloadedInstance);
        expect(new Set(imported.map(({ key }) => key.kind))).toEqual(
          new Set(["settings", "worker", "repository", "project", "label", "loop", "agent"]),
        );
        const migratedInstance = yield* Effect.fromResult(migrateProjects(instance.value));
        const valueDecoded1 = configurationEntities(migratedInstance);
        expect(configurationDiff(valueDecoded1, imported)).toEqual([]);
        for (const entity of imported) {
          const formattedEntity = yield* formatConfigurationEntity(entity);
          const edited = yield* parseConfigurationEntity(parser, entity.key, formattedEntity);
          expect(configurationDiff([entity], [edited])).toEqual([]);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(ConfigurationFolder.layer.pipe(Layer.provide(parserLayer))),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    it.effect("preserves worker order through imports, value changes, and revision replay", () =>
      Effect.gen(function* () {
        const fixtureInstance = yield* fixture;
        const store = yield* ConfigurationStore;
        yield* initialize;

        const original = configurationEntities(fixtureInstance);
        const workers = original.filter(({ key }) => key.kind === "worker");
        const other = original.filter(({ key }) => key.kind !== "worker");
        const [settings, ...rest] = other;
        if (settings === undefined) return yield* Effect.die("fixture has no settings");
        const reordered = [settings, ...[...workers].reverse(), ...rest];
        const added = ConfigurationEntity.make({
          key: ConfigurationEntityKey.make({
            kind: "worker",
            identifier: ConfigurationEntityId.make("new-preferred"),
          }),
          value: { name: "new-preferred", kind: "local", max_concurrent_attempts: 1 },
        });
        const resized = yield* Effect.forEach(original, (entity) =>
          Effect.gen(function* () {
            if (entity.key.kind !== "worker") return entity;
            const valueDecoded4 = yield* decodeObject(entity.value);
            return ConfigurationEntity.make({
              ...entity,
              value: { ...valueDecoded4, max_concurrent_attempts: 2 },
            });
          }),
        );
        for (const candidate of [
          [settings, ...workers, added, ...rest],
          original,
          reordered,
          resized,
          [settings, added, ...[...workers].reverse(), ...rest],
          original,
        ]) {
          const current = yield* store.read;
          const valueDecoded2 = Option.match(current.instance, {
            onNone: () => [],
            onSome: configurationEntities,
          });
          const changes = configurationDiff(valueDecoded2, candidate);
          expect(changes.length).toBeGreaterThan(0);
          if (current.number <= 2)
            expect(changes.map(({ key }) => key.key)).toEqual([added.key.key]);
          const revision = yield* store.commit({ expected: current.number, changes, ...metadata });
          expect(revision.changes.every(({ key }) => key.kind === "worker")).toBe(true);
          for (const entity of other)
            expect(
              (yield* store.list(Option.some(entity.key))).map(({ number }) => number),
            ).toEqual([1]);
          const saved = yield* store.read;
          const savedEntities = Option.map(saved.instance, configurationEntities);
          expect(savedEntities).toEqual(Option.some(candidate));
          expect(configurationDiff(candidate, candidate)).toEqual([]);
        }
        let replayed = Configuration.empty;
        for (const revision of yield* store.changes(zero).pipe(Stream.take(7), Stream.runCollect)) {
          replayed = (yield* commit(parser, replayed, replayed.number, revision.changes, revision))
            .configuration;
          if (revision.number === 4)
            expect(
              Option.map(replayed.instance, ({ config }) => config.workers.map(({ name }) => name)),
            ).toEqual(Option.some(["fallback", "local"]));
        }
        const storedConfiguration = yield* store.read;
        expect(replayed).toEqual(storedConfiguration);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("inserts and removes workers without changing surviving workers' history", () =>
      Effect.gen(function* () {
        const fixtureInstance = yield* fixture;
        const store = yield* ConfigurationStore;
        const initialRevision = yield* initialize;

        let replayed = (yield* commit(
          parser,
          Configuration.empty,
          zero,
          initialRevision.changes,
          initialRevision,
        )).configuration;

        const original = configurationEntities(fixtureInstance);
        const workers = original.filter(({ key }) => key.kind === "worker");
        const other = original.filter(({ key }) => key.kind !== "worker");
        const added = ConfigurationEntity.make({
          key: ConfigurationEntityKey.make({
            kind: "worker",
            identifier: ConfigurationEntityId.make("inserted"),
          }),
          value: { name: "inserted", kind: "local", max_concurrent_attempts: 1 },
        });
        for (let position = 0; position <= workers.length; position++) {
          const candidate = [
            ...other,
            ...workers.slice(0, position),
            added,
            ...workers.slice(position),
          ];
          for (const target of [candidate, original]) {
            const current = yield* store.read;
            const valueDecoded3 = Option.match(current.instance, {
              onNone: () => [],
              onSome: configurationEntities,
            });
            const changes = configurationDiff(valueDecoded3, target);
            expect(changes).toEqual([
              ConfigurationChange.make(
                target === candidate
                  ? {
                      key: added.key,
                      before: Option.none(),
                      after: Option.some(added.value),
                      position,
                    }
                  : { key: added.key, before: Option.some(added.value), after: Option.none() },
              ),
            ]);
            const revision = yield* store.commit({
              expected: current.number,
              changes,
              ...metadata,
            });
            expect(revision.changes).toEqual(changes);
            replayed = (yield* commit(
              parser,
              replayed,
              replayed.number,
              revision.changes,
              revision,
            )).configuration;
            const storedConfiguration = yield* store.read;
            expect(replayed).toEqual(storedConfiguration);
            expect(
              Option.map(replayed.instance, ({ config }) => config.workers.map(({ name }) => name)),
            ).toEqual(
              Option.some(
                target.filter(({ key }) => key.kind === "worker").map(({ key }) => key.identifier),
              ),
            );
          }
        }
        for (const entity of original)
          expect((yield* store.list(Option.some(entity.key))).map(({ number }) => number)).toEqual([
            1,
          ]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("rejects invalid ordering without writing a revision", () =>
      Effect.gen(function* () {
        const fixtureInstance = yield* fixture;
        const store = yield* ConfigurationStore;
        yield* initialize;
        const current = yield* store.read;

        const entities = configurationEntities(fixtureInstance);
        const workers = entities.filter(({ key }) => key.kind === "worker");
        for (const changes of [
          workers.map(({ key, value }) =>
            ConfigurationChange.make({
              key,
              before: Option.some(value),
              after: Option.some(value),
              position: 1,
            }),
          ),
          ...workers.map(({ key, value }) => [
            ConfigurationChange.make({
              key,
              before: Option.some(value),
              after: Option.some(value),
              position: workers.length,
            }),
          ]),
          workers.map(({ key, value }) =>
            ConfigurationChange.make({
              key,
              before: Option.some(value),
              after: Option.none(),
              position: 1,
            }),
          ),
          ...entities
            .filter(({ key }) => key.kind !== "worker")
            .map(({ key, value }) => [
              ConfigurationChange.make({
                key,
                before: Option.some(value),
                after: Option.some(value),
                position: 0,
              }),
            ]),
        ]) {
          const failure = yield* store
            .commit({ expected: current.number, changes, ...metadata })
            .pipe(Effect.flip);
          expect(failure._tag).toBe("ConfigurationInvalid");
          const storedConfiguration = yield* store.read;
          expect(storedConfiguration).toEqual(current);
          const entries = yield* store.list(Option.none());
          expect(entries).toHaveLength(1);
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect("refuses all-exe.dev and mixed workers without writing a revision", () =>
      Effect.gen(function* () {
        const fixtureInstance = yield* fixture;
        const store = yield* ConfigurationStore;
        yield* initialize;
        const current = yield* store.read;

        const workers = configurationEntities(fixtureInstance).filter(
          ({ key }) => key.kind === "worker",
        );
        const toExeDev = workers.map(({ key, value }) =>
          ConfigurationChange.make({
            key,
            before: Option.some(value),
            after: Option.some({ name: key.identifier, kind: "exe.dev" }),
          }),
        );
        for (const changes of [toExeDev, toExeDev.slice(1)]) {
          const failure = yield* store
            .commit({ expected: current.number, changes, ...metadata })
            .pipe(Effect.flip);
          assert(failure._tag === "ConfigurationInvalid", failure._tag);
          expect(failure.problems.map(({ file, message }) => ({ file, message }))).toEqual(
            changes.map(({ key }) => ({
              file: `worker:${key.identifier}`,
              message: `Worker "${key.identifier}" has kind exe.dev, which this version of usine doesn't run. Remove the worker or give it another kind.`,
            })),
          );
          const stored = yield* store.read;
          expect(stored).toEqual(current);
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "commits atomically, records before and after, filters history, and replays revisions",
      () =>
        Effect.gen(function* () {
          const store = yield* ConfigurationStore;
          const storedConfiguration = yield* store.read;
          expect(storedConfiguration).toEqual(Configuration.empty);
          const initialRevision = yield* initialize;
          const state = yield* store.read;
          expect(state.number).toBe(1);
          const key = ConfigurationEntityKey.make({
            kind: "agent",
            identifier: ConfigurationEntityId.make("developer"),
          });
          const agent = initialRevision.changes.find(
            ({ key: candidate }) => candidate.key === key.key,
          );
          expect(agent).toBeDefined();
          if (agent === undefined) return;
          const agentValue = yield* Effect.transposeOption(Option.map(agent.after, decodeObject));
          const change = ConfigurationChange.make({
            key,
            before: agent.after,
            after: Option.map(agentValue, (value) => ({
              ...value,
              harness: Harness.make("claude"),
              model: "claude-sonnet-4-6",
            })),
          });
          const second = yield* store.commit({
            expected: state.number,
            changes: [change],
            ...metadata,
          });
          expect(second.number).toBe(2);
          expect(second.changes[0]?.before).toEqual(agent.after);

          expect((yield* store.list(Option.some(key))).map(({ number }) => number)).toEqual([1, 2]);
          const currentRevision = yield* store.revision(second.number);
          expect(currentRevision).toEqual(Option.some(second));
          const streamed = yield* store.changes(zero).pipe(Stream.take(2), Stream.runCollect);
          expect(streamed.map(({ number }) => number)).toEqual([1, 2]);
          const current = yield* store.read;
          expect(Option.map(current.instance, ({ agents }) => agents[0]?.harness)).toEqual(
            Option.some("claude"),
          );
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "permits only one concurrent writer and leaves no revision for invalid references or CEL",
      () =>
        Effect.gen(function* () {
          const store = yield* ConfigurationStore;
          const initialRevision = yield* initialize;

          const loop = initialRevision.changes.find(({ key }) => key.kind === "loop");
          if (loop === undefined) return yield* Effect.die("fixture has no loop");
          const loopValue = yield* Effect.transposeOption(Option.map(loop.after, decodeObject));
          const invalid = ConfigurationChange.make({
            ...loop,
            before: loop.after,
            after: Option.map(loopValue, (value) => ({
              ...value,
              agent: "missing",
            })),
          });
          const failure = yield* store
            .commit({ expected: initialRevision.number, changes: [invalid], ...metadata })
            .pipe(Effect.flip);
          expect(failure._tag).toBe("ConfigurationInvalid");
          const invalidCel = ConfigurationChange.make({
            ...loop,
            before: loop.after,
            after: Option.map(loopValue, (value) => ({
              ...value,
              body: "{{ nonexistent.value }}",
            })),
          });
          const decodedValue2 = yield* store
            .commit({ expected: initialRevision.number, changes: [invalidCel], ...metadata })
            .pipe(Effect.flip);
          expect(decodedValue2._tag).toBe("ConfigurationInvalid");

          expect((yield* store.list(Option.none())).length).toBe(1);
          const results = yield* Effect.forEach(
            [1, 2],
            () =>
              store
                .commit({ expected: initialRevision.number, changes: [], ...metadata })
                .pipe(Effect.result),
            { concurrency: 2 },
          );
          expect(results.filter(Result.isSuccess)).toHaveLength(1);
          expect(results.filter(Result.isFailure).map(({ failure }) => failure._tag)).toEqual([
            "StaleRevision",
          ]);

          expect((yield* store.read).number).toBe(2);
        }).pipe(Effect.provide(layer)),
    );
  });

it.effect(
  "round-trips every entity kind through the folder format and reports errors across files",
  () =>
    Effect.gen(function* () {
      const fixtureInstance = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* ConfigurationFolder;
      const directory = yield* fs.makeTempDirectoryScoped();
      const root = InstanceDirectory.make(directory);

      const original = yield* Effect.fromResult(migrateProjects(fixtureInstance));
      yield* folder.export(root, original);
      const imported = yield* folder.load(root);
      expect(Equal.equals(imported, original)).toBe(true);
      const withoutLoops = LoadedInstance.make({ ...original, loops: [] });
      yield* folder.export(root, withoutLoops);
      yield* fs.remove(`${root}/projects`, { recursive: true });
      const reloadedInstance = yield* folder.load(root);
      expect(Equal.equals(reloadedInstance, withoutLoops)).toBe(true);
      const [project] = original.config.projects;
      if (project === undefined) return yield* Effect.die("fixture project missing");
      yield* fs.makeDirectory(`${root}/projects/${project.id}`, { recursive: true });
      yield* fs.writeFileString(`${root}/projects/${project.id}/loops`, "not a directory");
      const unreadable = yield* folder.load(root).pipe(Effect.flip);
      expect(unreadable.problems.map(({ file }) => file)).toContain(`projects/${project.id}/loops`);
      yield* fs.writeFileString(`${root}/usine.yaml`, "version: bad\nrepos: wrong\n");
      yield* fs.writeFileString(`${root}/agents/developer.md`, "broken");
      const failure = yield* folder.load(root).pipe(Effect.flip);
      expect(failure.problems.map(({ file }) => file)).toContain("usine.yaml");
      expect(failure.problems.map(({ file }) => file)).toContain("agents/developer.md");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ConfigurationFolder.layer.pipe(
          Layer.provide(parserLayer),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.live("observes another SQLite connection and preserves history after reopening", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() });
    const connection = () =>
      sqliteConfigurationLayer.pipe(
        Layer.provide(parserLayer),
        Layer.provide(SqliteClient.layer({ filename: `${directory}/configuration.sqlite` })),
      );
    const services = yield* Layer.build(connection());
    const first = Context.get(services, ConfigurationStore);

    const imported = yield* first.commit({
      expected: zero,
      changes: yield* initialChanges,
      ...metadata,
    });
    const secondConnectionServices = yield* Layer.build(connection());
    const second = Context.get(secondConnectionServices, ConfigurationStore);
    const watching = yield* first
      .changes(imported.number)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
    const revision = yield* second.commit({ expected: imported.number, changes: [], ...metadata });

    expect((yield* Fiber.join(watching)).map(({ number }) => number)).toEqual([revision.number]);
    const reopenedConnectionServices = yield* Layer.build(connection());
    const reopened = Context.get(reopenedConnectionServices, ConfigurationStore);

    expect((yield* reopened.read).number).toBe(2);

    expect((yield* reopened.list(Option.none())).map(({ number }) => number)).toEqual([1, 2]);
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
);

/**
 * Opens a SQLite store in a scoped temporary directory and commits the fixture with a schedule loop
 * `nightly`. It then rewrites the stored outcome labels as releases before the schedule and
 * letter-case rules saved them: `implement` with `[ready, Ready, review]` and `nightly` with
 * `[passed]`.
 */
const legacyOutcomeLabelStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() });
  const sqlite = SqliteClient.layer({ filename: `${directory}/configuration.sqlite` });
  const open = Effect.map(
    Layer.build(sqliteConfigurationLayer.pipe(Layer.provide(parserLayer), Layer.provide(sqlite))),
    (services) => Context.get(services, ConfigurationStore),
  );
  const first = yield* open;
  const nightly = yield* parser.parseLoopFile(
    InstancePath.make("loops/nightly.md"),
    "---\ntrigger: { on: schedule, cron: '0 3 * * *', if: 'true' }\nagent: developer\n---\nCheck the build.\n",
  );
  const nightlyValue = yield* Schema.encodeEffect(LoopJson)(nightly);
  const imported = yield* initialChanges;
  yield* first.commit({
    expected: zero,
    changes: [
      ...imported,
      ConfigurationChange.make({
        key: ConfigurationEntityKey.make({
          kind: "loop",
          identifier: ConfigurationEntityId.make("nightly"),
        }),
        before: Option.none(),
        after: Option.some(nightlyValue),
      }),
    ],
    ...metadata,
  });

  const sqlServices = yield* Layer.build(sqlite);
  const sql = Context.get(sqlServices, SqlClient.SqlClient);
  const StoredRow = Schema.fromJsonString(
    Schema.Struct({ key: Schema.Json, value: Schema.JsonObject }),
  );
  const legacy = { "loop:implement": ["ready", "Ready", "review"], "loop:nightly": ["passed"] };
  for (const [key, outcomeLabels] of Object.entries(legacy)) {
    const [row] = yield* sql<{
      readonly value: string;
    }>`SELECT value FROM usine_configuration_entities WHERE key = ${key}`;
    if (row === undefined) return yield* Effect.die(`missing ${key}`);
    const entity = yield* Schema.decodeEffect(StoredRow)(row.value);
    const value = yield* Schema.encodeEffect(StoredRow)({
      ...entity,
      value: { ...entity.value, outcomeLabels },
    });
    yield* sql`UPDATE usine_configuration_entities SET value = ${value} WHERE key = ${key}`;
  }
  const revisions = Effect.map(
    sql<{
      readonly number: number;
    }>`SELECT number FROM usine_configuration_revisions ORDER BY number`,
    (rows) => rows.map(({ number }) => number),
  );
  return { first, open, sql, revisions };
});

it.live("rewrites stored outcome labels that the loop rules reject when it opens", () =>
  Effect.gen(function* () {
    const { first, open, sql, revisions } = yield* legacyOutcomeLabelStore;
    const refused = yield* first.read.pipe(Effect.flip);
    expect(String(refused.cause)).toContain("ConfigurationInvalid");

    // A failed upgrade leaves no revision behind.
    yield* sql`CREATE TRIGGER refuse_entity_update BEFORE UPDATE ON usine_configuration_entities
      BEGIN SELECT RAISE(ABORT, 'entity update refused'); END`;
    const failed = yield* open.pipe(Effect.flip);
    expect(failed).toMatchObject({ operation: "upgrade stored loops" });
    const stored = yield* revisions;
    expect(stored).toEqual([1]);
    yield* sql`DROP TRIGGER refuse_entity_update`;

    const reopened = yield* open;
    const upgraded = yield* reopened.read;
    expect(upgraded.number).toBe(2);
    assert(Option.isSome(upgraded.instance));
    expect(
      Object.fromEntries(
        upgraded.instance.value.loops.map(({ name, outcomeLabels }) => [name, outcomeLabels]),
      ),
    ).toEqual({ implement: ["ready", "review"], nightly: [] });
    const revision = yield* reopened.revision(ConfigurationRevisionNumber.make(2));
    assert(Option.isSome(revision));
    expect(revision.value.actor).toEqual(Option.none());
    expect(revision.value.changes.map(({ key }) => key.key).sort()).toEqual([
      "loop:implement",
      "loop:nightly",
    ]);
    // History shows the values the current loop rules reject as their stored JSON.
    const implement = revision.value.changes.find(({ key }) => key.key === "loop:implement");
    assert(implement !== undefined && Option.isSome(implement.before));
    const before = ConfigurationEntity.make({ key: implement.key, value: implement.before.value });
    yield* formatConfigurationEntity(before).pipe(Effect.flip);
    const beforeText = yield* formatRevisionEntity(before);
    expect(beforeText).toContain("- Ready\n");
    for (const change of revision.value.changes) {
      assert(Option.isSome(change.after));
      const after = ConfigurationEntity.make({ key: change.key, value: change.after.value });
      const afterText = yield* formatRevisionEntity(after);
      const formatted = yield* formatConfigurationEntity(after);
      expect(afterText).toBe(formatted);
    }
    const edited = yield* reopened.commit({
      expected: upgraded.number,
      changes: [],
      ...metadata,
    });
    expect(edited.number).toBe(3);
    expect((yield* (yield* open).list(Option.none())).map(({ number }) => number)).toEqual([
      1, 2, 3,
    ]);
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
);

it.live("keeps stored outcome labels when the upgraded configuration is still invalid", () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return Effect.gen(function* () {
    const { open, sql, revisions } = yield* legacyOutcomeLabelStore;
    yield* sql`DELETE FROM usine_configuration_entities WHERE key = 'agent:developer'`;

    const reopened = yield* open;
    const stored = yield* revisions;
    expect(stored).toEqual([1]);
    const refused = yield* reopened.read.pipe(Effect.flip);
    expect(String(refused.cause)).toContain("ConfigurationInvalid");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual([
      "Kept stored outcome labels; the upgraded configuration is invalid",
      expect.objectContaining({ loops: ["implement", "nightly"] }),
    ]);
  }).pipe(
    Effect.scoped,
    Effect.timeout("10 seconds"),
    Effect.provide(NodeServices.layer),
    Effect.withLogger(logger),
  );
});

const extraLabel = ConfigurationChange.make({
  key: ConfigurationEntityKey.make({
    kind: "label",
    identifier: ConfigurationEntityId.make("extra"),
  }),
  before: Option.none(),
  after: Option.some({ name: "extra" }),
});
/**
 * Changes worker `fallback` in `configuration` from its stored value to kind `kind`, or removes it
 * when `kind` is none.
 */
const fallbackChange = (configuration: Configuration, kind: Option.Option<string>) =>
  Effect.gen(function* () {
    assert(Option.isSome(configuration.instance));
    const stored = configurationEntities(configuration.instance.value).find(
      ({ key }) => key.key === "worker:fallback",
    );
    if (stored === undefined) return yield* Effect.die("missing worker:fallback");
    return ConfigurationChange.make({
      key: stored.key,
      before: Option.some(stored.value),
      after: Option.map(kind, (value) => ({ name: "fallback", kind: value })),
    });
  });
const exeDevRefusal = {
  file: "worker:fallback",
  message: `Worker "fallback" has kind exe.dev, which this version of usine doesn't run. Remove the worker or give it another kind.`,
};

/**
 * Opens a SQLite store in a scoped temporary directory and commits the fixture. It then writes
 * revision 2, which sets worker `fallback` to kind exe.dev, as releases before the store refused
 * exe.dev workers saved it.
 */
const exeDevWorkerStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ directory: sqliteTempDirectory() });
  const sqlite = SqliteClient.layer({ filename: `${directory}/configuration.sqlite` });
  const services = yield* Layer.build(
    sqliteConfigurationLayer.pipe(Layer.provide(parserLayer), Layer.provideMerge(sqlite)),
  );
  const store = Context.get(services, ConfigurationStore);
  const sql = Context.get(services, SqlClient.SqlClient);
  yield* store.commit({ expected: zero, changes: yield* initialChanges, ...metadata });
  const current = yield* store.read;
  const toExeDev = yield* fallbackChange(current, Option.some("exe.dev"));
  const { configuration, revision } = yield* replay(
    parser,
    current,
    current.number,
    [toExeDev],
    metadata,
  );
  assert(Option.isSome(configuration.instance));
  const exeDev = configurationEntities(configuration.instance.value).find(
    ({ key }) => key.key === "worker:fallback",
  );
  if (exeDev === undefined) return yield* Effect.die("missing worker:fallback");
  const value = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(ConfigurationRevision)),
  )(revision);
  yield* sql`INSERT INTO usine_configuration_revisions (number, value) VALUES (${revision.number}, ${value})`;
  const entity = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(ConfigurationEntity)),
  )(exeDev);
  yield* sql`UPDATE usine_configuration_entities SET value = ${entity} WHERE key = 'worker:fallback'`;
  const revisions = Effect.map(
    sql<{
      readonly number: number;
    }>`SELECT number FROM usine_configuration_revisions ORDER BY number`,
    (rows) => rows.map(({ number }) => number),
  );
  return { store, revisions };
});

it.live("reads a stored exe.dev worker and refuses other saves until it is removed", () =>
  Effect.gen(function* () {
    const { store, revisions } = yield* exeDevWorkerStore;
    const stored = yield* store.read;
    expect(stored.number).toBe(2);
    assert(Option.isSome(stored.instance));
    expect(stored.instance.value.config.workers.map(({ name, kind }) => `${name}:${kind}`)).toEqual(
      ["local:local", "fallback:exe.dev"],
    );

    const refused = yield* store
      .commit({ expected: stored.number, changes: [extraLabel], ...metadata })
      .pipe(Effect.flip);
    assert(refused._tag === "ConfigurationInvalid", refused._tag);
    expect(refused.problems.map(({ file, message }) => ({ file, message }))).toEqual([
      exeDevRefusal,
    ]);
    const kept = yield* revisions;
    expect(kept).toEqual([1, 2]);

    for (const kind of [Option.none(), Option.some("local")]) {
      const fresh = yield* exeDevWorkerStore;
      const change = yield* fallbackChange(stored, kind);
      const committed = yield* fresh.store.commit({
        expected: stored.number,
        changes: [change],
        ...metadata,
      });
      expect(committed.number).toBe(3);
      const saved = yield* fresh.store.read;
      assert(Option.isSome(saved.instance));
      expect(
        saved.instance.value.config.workers.map(({ name, kind }) => `${name}:${kind}`),
      ).toEqual(Option.isSome(kind) ? ["local:local", "fallback:local"] : ["local:local"]);
    }
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
);

it.live("reverts a revision over a history that holds an exe.dev worker", () =>
  Effect.gen(function* () {
    const { store, revisions } = yield* exeDevWorkerStore;
    const revertOf = (number: number) =>
      Effect.gen(function* () {
        const current = yield* store.read;
        const target = yield* store.revision(ConfigurationRevisionNumber.make(number));
        assert(Option.isSome(target));
        const history = yield* store.list(Option.none());
        const changes = yield* revertConfiguration(parser, target.value, history, current);
        return yield* store.commit({ expected: current.number, changes, ...metadata });
      });
    const seeded = yield* store.read;
    const toLocal = yield* fallbackChange(seeded, Option.some("local"));
    yield* store.commit({ expected: seeded.number, changes: [toLocal], ...metadata });
    yield* store.commit({
      expected: ConfigurationRevisionNumber.make(3),
      changes: [extraLabel],
      ...metadata,
    });

    // Reverting revision 4 replays revision 2, which holds the exe.dev worker.
    const reverted = yield* revertOf(4);
    expect(reverted.number).toBe(5);
    const current = yield* store.read;
    assert(Option.isSome(current.instance));
    expect(current.instance.value.config.labels.map(({ name }) => name)).not.toContain("extra");

    // Reverting revision 3 would bring the exe.dev worker back.
    const refused = yield* revertOf(3).pipe(Effect.flip);
    assert(refused._tag === "ConfigurationInvalid", refused._tag);
    expect(refused.problems.map(({ file, message }) => ({ file, message }))).toEqual([
      exeDevRefusal,
    ]);
    const written = yield* revisions;
    expect(written).toEqual([1, 2, 3, 4, 5]);
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
);
