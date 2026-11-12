import { Harness } from "@usine/core/agent/brain";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigurationFolder } from "@usine/config/folder-codec";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, FileSystem, Layer, Option } from "effect";
import {
  developerAgent,
  type QuickstartRoute,
  quickstartRoutes,
} from "../src/quickstart/routes.ts";

const bootstrap = InstanceDirectory.make(fileURLToPath(new URL("../quickstart", import.meta.url)));
const folderLayer = ConfigurationFolder.layer.pipe(
  Layer.provide(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
  Layer.provide(NodeServices.layer),
);

const loadsQuickstart = (root: InstanceDirectory, route: QuickstartRoute) =>
  Effect.gen(function* () {
    const folder = yield* ConfigurationFolder;
    const instance = yield* folder.load(root);
    expect(instance.config.projects.map(({ id }) => id)).toEqual(["scratch"]);
    expect(instance.config.workers.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "local", kind: "local" },
    ]);
    expect(
      instance.agents.map(({ name, harness, model, effort, coordinator, parentModel }) => ({
        name,
        harness,
        model,
        effort,
        coordinator,
        parentModel,
      })),
    ).toEqual([
      {
        name: "developer",
        harness: Harness.make(route.harness),
        model: route.model,
        effort: "medium",
        coordinator: Option.none(),
        parentModel: Option.none(),
      },
    ]);
    expect(instance.config.settings.coordinator).toEqual("events");
    expect(instance.config.settings.parentModel).toEqual(Option.none());
    expect(instance.loops.map(({ name, agent, approval }) => ({ name, agent, approval }))).toEqual([
      { name: "scratch/first-pr", agent: "developer", approval: "required" },
    ]);
    expect(instance.warnings).toEqual([]);
  });

it.effect("publishes the developer agent of one quickstart route", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const published = yield* fs.readFileString(`${bootstrap}/agents/developer.md`);
    expect(quickstartRoutes.map(developerAgent)).toContain(published);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const route of quickstartRoutes) {
  it.effect(`loads the quickstart with the ${route.label} developer agent`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = InstanceDirectory.make(yield* fs.makeTempDirectoryScoped());
      yield* fs.copy(bootstrap, root);
      yield* fs.writeFileString(`${root}/agents/developer.md`, developerAgent(route));
      yield* loadsQuickstart(root, route);
    }).pipe(
      Effect.scoped,
      Effect.provide(folderLayer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );
}

for (const file of ["usine.yaml", "agents/developer.md", "projects/scratch/loops/first-pr.md"]) {
  it.effect(`rejects an invalid quickstart file: ${file}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* ConfigurationFolder;
      const directory = yield* fs.makeTempDirectoryScoped();
      const root = InstanceDirectory.make(directory);
      yield* fs.copy(bootstrap, root);
      yield* fs.writeFileString(`${root}/${file}`, "invalid: true\n");
      const failure = yield* folder.load(root).pipe(Effect.flip);
      expect(failure.problems.map(({ file }) => file)).toContain(file);
    }).pipe(
      Effect.scoped,
      Effect.provide(folderLayer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );
}
