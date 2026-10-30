import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  ConfigurationStore,
  ConfigurationChange,
  ConfigurationRevisionNumber,
  configurationDiff,
  configurationEntities,
} from "@usine/config/configuration";
import { ConfigurationFolder } from "@usine/config/folder-codec";
import { memoryConfigurationLayer } from "@usine/config/memory";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Context, Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { writeInstanceFiles } from "./support/instance-folder.ts";

const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
const dependencies = Layer.mergeAll(memoryConfigurationLayer, ConfigurationFolder.layer).pipe(
  Layer.provideMerge(parser),
);

it.live("applies committed agent brains and webhook settings live", () =>
  Effect.gen(function* () {
    const root = InstanceDirectory.make(
      yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
    );
    yield* writeInstanceFiles(root, [
      [
        "usine.yaml",
        "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\nprojects: [{ id: acme-project, name: Project, repositories: [acme/project] }]\n",
      ],
      [
        "agents/developer.md",
        "---\nharness: codex\nmodel: gpt-6.1-sol\neffort: high\n---\nImplement the issue.\n",
      ],
      [
        "projects/acme-project/loops/implement.md",
        "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n---\nImplement.\n",
      ],
    ]);
    const services = yield* Layer.build(dependencies);
    const store = Context.get(services, ConfigurationStore);
    const initial = yield* Context.get(services, ConfigurationFolder).load(root);
    const revision = yield* store.commit({
      expected: ConfigurationRevisionNumber.make(0),
      changes: configurationDiff([], configurationEntities(initial)),
      actor: initial.config.operator,
      message: Option.none(),
    });
    const context = yield* Layer.build(
      CurrentInstance.layer(root, initial, revision.number).pipe(
        Layer.provide(Layer.succeedContext(services)),
      ),
    );
    const current = Context.get(context, CurrentInstance);
    const preflighted: Array<string> = [];
    yield* current.registerWorkers((_, loaded) =>
      Effect.sync(() => {
        preflighted.push(...loaded.agents.map(({ harness }) => harness));
        return Effect.void;
      }),
    );
    const next = yield* current.changes.pipe(
      Stream.filter(({ agents }) => agents[0]?.harness === "claude"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    const agent = revision.changes.find(({ key }) => key.kind === "agent");
    if (agent === undefined) return yield* Effect.die("missing agent fixture");
    const changed = yield* store.commit({
      expected: revision.number,
      actor: initial.config.operator,
      message: Option.none(),
      changes: [
        new ConfigurationChange({
          ...agent,
          before: agent.after,
          after: Option.map(agent.after, (value) => ({
            ...Schema.decodeUnknownSync(Schema.JsonObject)(value),
            harness: "claude",
          })),
        }),
      ],
    });
    yield* Fiber.join(next);
    expect(preflighted).toEqual(["claude"]);
    expect((yield* current.get).agents[0]?.agent.brain.harness).toBe("claude");
    const settings = revision.changes.find(({ key }) => key.kind === "settings");
    if (settings === undefined) return yield* Effect.die("missing settings fixture");
    yield* store.commit({
      expected: changed.number,
      actor: initial.config.operator,
      message: Option.none(),
      changes: [
        new ConfigurationChange({
          ...settings,
          before: settings.after,
          after: Option.map(settings.after, (value) => ({
            ...Schema.decodeUnknownSync(Schema.JsonObject)(value),
            webhooks: { mode: "deliveries" },
          })),
        }),
      ],
    });
    yield* current.reload;
    expect((yield* current.get).config.webhooks.mode).toBe("deliveries");
    expect(Option.map((yield* store.read).instance, ({ config }) => config.webhooks.mode)).toEqual(
      Option.some("deliveries"),
    );
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
);
