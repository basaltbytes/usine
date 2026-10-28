import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
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
  ConfigurationRevisionNumber,
  ConfigurationStore,
} from "../src/configuration/store.ts";
import { ConfigurationFolder } from "../src/configuration/folder.ts";
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
    "---\ntrigger:\n  on: issue\n  if: item.number > 0\nagent: developer\nselector:\n  tags: [app]\n---\nImplement #{{ item.number }}.\n",
  );
  return new LoadedInstance({
    config,
    agents: [agent],
    loops: [loop],
    warnings: [],
    invalidAgents: [],
    quarantinedLoops: [],
  });
});

const initialChanges = Effect.map(fixture, (instance) =>
  configurationDiff([], configurationEntities(instance)),
);
const initialize = Effect.gen(function* () {
  const store = yield* ConfigurationStore;
  const changes = yield* initialChanges;
  return yield* store.commit({ expected: zero, changes, ...metadata });
});

describe("configuration domain without layers", () => {
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
        .map(
          (change) =>
            new ConfigurationChange({
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
          new ConfigurationChange({
            ...worker,
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
    it.effect("preserves worker order through imports, value changes, and revision replay", () =>
      Effect.gen(function* () {
        const store = yield* ConfigurationStore;
        yield* initialize;
        const original = configurationEntities(yield* fixture);
        const workers = original.filter(({ key }) => key.kind === "worker");
        const other = original.filter(({ key }) => key.kind !== "worker");
        const [settings, ...rest] = other;
        if (settings === undefined) return yield* Effect.die("fixture has no settings");
        const reordered = [settings, ...workers.toReversed(), ...rest];
        for (const candidate of [
          reordered,
          original.map((entity) =>
            entity.key.kind === "worker"
              ? new ConfigurationEntity({
                  ...entity,
                  value: {
                    ...Schema.decodeUnknownSync(Schema.JsonObject)(entity.value),
                    max_concurrent_attempts: 2,
                  },
                })
              : entity,
          ),
        ]) {
          const current = yield* store.read;
          const changes = configurationDiff(
            Option.match(current.instance, { onNone: () => [], onSome: configurationEntities }),
            candidate,
          );
          expect(changes.length).toBeGreaterThan(0);
          yield* store.commit({ expected: current.number, changes, ...metadata });
          const saved = yield* store.read;
          expect(Option.map(saved.instance, configurationEntities)).toEqual(Option.some(candidate));
          expect(configurationDiff(candidate, candidate)).toEqual([]);
        }
        let replayed = Configuration.empty;
        for (const revision of yield* store.changes(zero).pipe(Stream.take(3), Stream.runCollect)) {
          replayed = (yield* commit(parser, replayed, replayed.number, revision.changes, revision))
            .configuration;
          if (revision.number === 2)
            expect(
              Option.map(replayed.instance, ({ config }) => config.workers.map(({ name }) => name)),
            ).toEqual(Option.some(["fallback", "local"]));
        }
        expect(replayed).toEqual(yield* store.read);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "commits atomically, records before and after, filters history, and replays revisions",
      () =>
        Effect.gen(function* () {
          const store = yield* ConfigurationStore;
          expect(yield* store.read).toEqual(Configuration.empty);
          const first = yield* initialize;
          const state = yield* store.read;
          expect(state.number).toBe(1);
          const key = new ConfigurationEntityKey({
            kind: "agent",
            identifier: ConfigurationEntityId.make("developer"),
          });
          const agent = first.changes.find(({ key: candidate }) => candidate.key === key.key);
          expect(agent).toBeDefined();
          if (agent === undefined) return;
          const change = new ConfigurationChange({
            key,
            before: agent.after,
            after: Option.map(agent.after, (value) => {
              const object = Schema.decodeUnknownSync(Schema.JsonObject)(value);
              return { ...object, harness: "claude", model: "claude-sonnet-4-6" };
            }),
          });
          const second = yield* store.commit({
            expected: state.number,
            changes: [change],
            ...metadata,
          });
          expect(second.number).toBe(2);
          expect(second.changes[0]?.before).toEqual(agent.after);
          expect((yield* store.list(Option.some(key))).map(({ number }) => number)).toEqual([1, 2]);
          expect(yield* store.revision(second.number)).toEqual(Option.some(second));
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
          const first = yield* initialize;
          const loop = first.changes.find(({ key }) => key.kind === "loop");
          if (loop === undefined) return yield* Effect.die("fixture has no loop");
          const invalid = new ConfigurationChange({
            ...loop,
            before: loop.after,
            after: Option.map(loop.after, (value) => ({
              ...Schema.decodeUnknownSync(Schema.JsonObject)(value),
              agent: "missing",
            })),
          });
          const failure = yield* store
            .commit({ expected: first.number, changes: [invalid], ...metadata })
            .pipe(Effect.flip);
          expect(failure._tag).toBe("ConfigurationInvalid");
          const invalidCel = new ConfigurationChange({
            ...loop,
            before: loop.after,
            after: Option.map(loop.after, (value) => ({
              ...Schema.decodeUnknownSync(Schema.JsonObject)(value),
              body: "{{ nonexistent.value }}",
            })),
          });
          expect(
            (yield* store
              .commit({ expected: first.number, changes: [invalidCel], ...metadata })
              .pipe(Effect.flip))._tag,
          ).toBe("ConfigurationInvalid");
          expect((yield* store.list(Option.none())).length).toBe(1);
          const results = yield* Effect.all(
            [1, 2].map(() =>
              store
                .commit({ expected: first.number, changes: [], ...metadata })
                .pipe(Effect.result),
            ),
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
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* ConfigurationFolder;
      const root = InstanceDirectory.make(yield* fs.makeTempDirectoryScoped());
      const original = yield* fixture;
      yield* folder.export(root, original);
      const imported = yield* folder.load(root);
      expect(Equal.equals(imported, original)).toBe(true);
      yield* fs.writeFileString(`${root}/usine.yaml`, "version: bad\nrepos: wrong\n");
      yield* fs.writeFileString(`${root}/agents/developer.md`, "broken");
      const failure = yield* folder.load(root).pipe(Effect.flip);
      expect(failure.problems.map(({ file }) => file)).toContain("usine.yaml");
      expect(failure.problems.map(({ file }) => file)).toContain("agents/developer.md");
    }).pipe(
      Effect.scoped,
      Effect.provide(ConfigurationFolder.layer.pipe(Layer.provide(parserLayer))),
      Effect.provide(NodeServices.layer),
    ),
);

it.live("observes another SQLite connection and preserves history after reopening", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const connection = () =>
      sqliteConfigurationLayer.pipe(
        Layer.provide(parserLayer),
        Layer.provide(SqliteClient.layer({ filename: `${directory}/configuration.sqlite` })),
      );
    const first = Context.get(yield* Layer.build(connection()), ConfigurationStore);
    const imported = yield* first.commit({
      expected: zero,
      changes: yield* initialChanges,
      ...metadata,
    });
    const second = Context.get(yield* Layer.build(connection()), ConfigurationStore);
    const watching = yield* first
      .changes(imported.number)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
    const revision = yield* second.commit({ expected: imported.number, changes: [], ...metadata });
    expect((yield* Fiber.join(watching)).map(({ number }) => number)).toEqual([revision.number]);
    const reopened = Context.get(yield* Layer.build(connection()), ConfigurationStore);
    expect((yield* reopened.read).number).toBe(2);
    expect((yield* reopened.list(Option.none())).map(({ number }) => number)).toEqual([1, 2]);
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
);
