import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigurationFolder } from "@usine/config/folder-codec";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, FileSystem, Layer, Option } from "effect";

const bootstrap = InstanceDirectory.make(fileURLToPath(new URL("../quickstart", import.meta.url)));
const folderLayer = ConfigurationFolder.layer.pipe(
  Layer.provide(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
  Layer.provide(NodeServices.layer),
);

it.effect("loads the published quickstart with one runnable loop on the local worker", () =>
  Effect.gen(function* () {
    const folder = yield* ConfigurationFolder;
    const instance = yield* folder.load(bootstrap);
    expect(instance.config.projects.map(({ id }) => id)).toEqual(["scratch"]);
    expect(instance.config.workers.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "local", kind: "local" },
    ]);
    expect(
      instance.agents.map(({ name, harness, model, effort, parentModel }) => ({
        name,
        harness,
        model,
        effort,
        parentModel,
      })),
    ).toEqual([
      {
        name: "developer",
        harness: "codex",
        model: "gpt-6-astra",
        effort: "medium",
        parentModel: Option.none(),
      },
    ]);
    expect(instance.config.settings.parentModel).toEqual(Option.some("openai-codex/gpt-6-astra"));
    expect(instance.loops.map(({ name, agent, approval }) => ({ name, agent, approval }))).toEqual([
      { name: "scratch/first-pr", agent: "developer", approval: "required" },
    ]);
    expect(instance.warnings).toEqual([]);
  }).pipe(Effect.provide(folderLayer)),
);

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
