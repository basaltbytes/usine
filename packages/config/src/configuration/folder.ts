import { InstanceDirectory } from "@usine/core/instance";
import {
  Array as Arr,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
} from "effect";
import { AgentFile } from "../agent.ts";
import { UsineConfig } from "../factory.ts";
import { ConfigFileError, InstancePath } from "../file.ts";
import { LoadedInstance } from "../instance/instance.ts";
import { loopReferenceFailure, referenceIndex } from "../instance/references.ts";
import { LoopFile, loopPath } from "../loop.ts";
import { ConfigParser, formatAgent, formatLoop } from "../parser.ts";
import { writeYaml } from "../yaml/writer.ts";
import { configurationWarnings } from "./commit.ts";
import { ConfigurationInvalid, ConfigurationStoreError } from "./model.ts";

export {
  ConfigurationFormKind,
  parseConfigurationForm,
  validateConfigurationForm,
} from "./forms.ts";

export { formatConfigurationEntity, parseConfigurationEntity } from "./format.ts";

export class ConfigurationFolder extends Context.Service<
  ConfigurationFolder,
  {
    readonly load: (root: InstanceDirectory) => Effect.Effect<LoadedInstance, ConfigurationInvalid>;
    readonly export: (
      root: InstanceDirectory,
      instance: LoadedInstance,
    ) => Effect.Effect<void, ConfigurationStoreError>;
  }
>()("@usine/config/ConfigurationFolder") {
  static readonly layer = Layer.effect(
    ConfigurationFolder,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parser = yield* ConfigParser;
      const fileError = (file: string, message: string) =>
        new ConfigFileError({
          file: InstancePath.make(file),
          stage: "read",
          expression: Option.none(),
          message,
        });
      const read = (root: InstanceDirectory, file: string) =>
        fs
          .readFileString(path.join(root, file))
          .pipe(Effect.mapError((error) => fileError(file, error.message)));
      const files = (root: InstanceDirectory, directory: string) =>
        fs.readDirectory(path.join(root, directory)).pipe(
          Effect.map((names) => names.filter((name) => name.endsWith(".md")).sort()),
          Effect.mapError((error) => fileError(directory, error.message)),
        );
      return ConfigurationFolder.of({
        load: Effect.fn("ConfigurationFolder.load")(
          function* (root) {
            yield* Effect.annotateCurrentSpan({ directory: root });
            const problems: Array<ConfigFileError> = [];
            const config = yield* read(root, "usine.yaml").pipe(
              Effect.flatMap((source) =>
                parser.parseUsineYaml(InstancePath.make("usine.yaml"), source),
              ),
              Effect.result,
            );
            if (Result.isFailure(config)) problems.push(config.failure);
            const load = <A>(
              directory: string,
              parse: (file: InstancePath, source: string) => Effect.Effect<A, ConfigFileError>,
            ) =>
              Effect.gen(function* () {
                const names = yield* files(root, directory).pipe(Effect.result);
                if (Result.isFailure(names)) {
                  problems.push(names.failure);
                  return [];
                }
                const parsed = yield* Effect.forEach(
                  names.success,
                  (name) => {
                    const file = InstancePath.make(`${directory}/${name}`);
                    return read(root, file).pipe(
                      Effect.flatMap((source) => parse(file, source)),
                      Effect.result,
                    );
                  },
                  { concurrency: 16 },
                );
                const values: Array<A> = [];
                for (const result of parsed) {
                  if (Result.isSuccess(result)) values.push(result.success);
                  else problems.push(result.failure);
                }
                return values;
              });
            const agents = yield* load<AgentFile>("agents", parser.parseAgentFile);
            const loops = yield* load<LoopFile>("loops", parser.parseLoopFile);
            if (Result.isSuccess(config)) {
              const references = referenceIndex(config.success, agents);
              for (const loop of loops) {
                const failure = loopReferenceFailure(loopPath(loop.name), loop, references);
                if (Option.isSome(failure)) problems.push(failure.value);
              }
            }
            if (Arr.isArrayNonEmpty(problems)) return yield* new ConfigurationInvalid({ problems });
            if (Result.isFailure(config))
              return yield* new ConfigurationInvalid({ problems: [config.failure] });
            return new LoadedInstance({
              config: config.success,
              agents,
              loops,
              warnings: yield* configurationWarnings(parser, config.success, loops),
              invalidAgents: [],
              quarantinedLoops: [],
            });
          },
          Effect.tapError(({ problems }) =>
            Effect.logWarning("Configuration folder rejected", { problems: problems.length }),
          ),
        ),
        export: Effect.fn("ConfigurationFolder.export")(
          function* (root, instance) {
            yield* Effect.annotateCurrentSpan({ directory: root });
            yield* fs.makeDirectory(root, { recursive: true });
            yield* fs.writeFileString(
              path.join(root, "usine.yaml"),
              writeYaml(Schema.encodeSync(UsineConfig)(instance.config)),
            );
            const write = (
              directory: string,
              documents: ReadonlyArray<readonly [string, string]>,
            ) =>
              Effect.gen(function* () {
                const target = path.join(root, directory);
                yield* fs.makeDirectory(target, { recursive: true });
                const keep = new Set(documents.map(([name]) => `${name}.md`));
                for (const name of yield* fs.readDirectory(target)) {
                  if (name.endsWith(".md") && !keep.has(name))
                    yield* fs.remove(path.join(target, name));
                }
                yield* Effect.forEach(
                  documents,
                  ([name, source]) => fs.writeFileString(path.join(target, `${name}.md`), source),
                  { discard: true },
                );
              });
            yield* write(
              "agents",
              instance.agents.map((agent) => [agent.name, formatAgent(agent)]),
            );
            yield* write(
              "loops",
              instance.loops.map((loop) => [loop.name, formatLoop(loop)]),
            );
            yield* Effect.logInfo("Configuration exported", { directory: root });
          },
          Effect.mapError(
            (cause) =>
              new ConfigurationStoreError({ operation: "export configuration folder", cause }),
          ),
        ),
      });
    }),
  );
}
