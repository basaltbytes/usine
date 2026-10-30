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
import { migrateProjects } from "../project/operations.ts";
import { configurationWarnings } from "./commit.ts";
import { ConfigurationInvalid, ConfigurationStoreError } from "./model.ts";

export {
  ConfigurationFormKind,
  parseConfigurationForm,
  validateConfigurationForm,
} from "./forms.ts";

export { formatConfigurationEntity, parseConfigurationEntity } from "./format.ts";

/**
 * Imports and exports configuration as instance-folder files (ADR 0031). Import rejects invalid
 * files as a whole.
 */
export class ConfigurationFolder extends Context.Service<
  ConfigurationFolder,
  {
    /**
     * Reads configuration files from `root`, validates all entities and references, and converts
     * version 1 configuration to projects. Any invalid file fails the import with
     * `ConfigurationInvalid`; no store revision is written.
     */
    readonly load: (root: InstanceDirectory) => Effect.Effect<LoadedInstance, ConfigurationInvalid>;
    /**
     * Writes `instance` to `root`, creating directories and replacing complete YAML and Markdown
     * files. Removes stale Markdown files in written entity directories; comments are not
     * preserved. Filesystem failures become `ConfigurationStoreError`.
     */
    readonly export: (
      root: InstanceDirectory,
      instance: LoadedInstance,
    ) => Effect.Effect<void, ConfigurationStoreError>;
  }
>()("@usine/config/ConfigurationFolder") {
  /** Provides strict folder import and export using `FileSystem`, `Path`, and `ConfigParser`. */
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
      const files = (root: InstanceDirectory, directory: string, missing: "empty" | "error") =>
        fs.readDirectory(path.join(root, directory)).pipe(
          Effect.catchIf(
            (error) => missing === "empty" && error.reason._tag === "NotFound",
            () =>
              Effect.logDebug("Configuration folder has no loop files", { directory }).pipe(
                Effect.as([]),
              ),
          ),
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
              missing: "empty" | "error",
              parse: (file: InstancePath, source: string) => Effect.Effect<A, ConfigFileError>,
            ) =>
              Effect.gen(function* () {
                const names = yield* files(root, directory, missing).pipe(Effect.result);
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
            const agents = yield* load<AgentFile>("agents", "error", parser.parseAgentFile);
            const loops =
              Result.isSuccess(config) && config.success.version === 2
                ? (yield* Effect.forEach(config.success.projects, (project) =>
                    load<LoopFile>(`projects/${project.id}/loops`, "empty", parser.parseLoopFile),
                  )).flat()
                : yield* load<LoopFile>("loops", "error", parser.parseLoopFile);
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
            return yield* Effect.fromResult(
              migrateProjects(
                new LoadedInstance({
                  config: config.success,
                  agents,
                  loops,
                  warnings: yield* configurationWarnings(parser, config.success, loops),
                  invalidAgents: [],
                  quarantinedLoops: [],
                }),
              ),
            );
          },
          Effect.tapError(({ problems }) =>
            Effect.forEach(
              problems,
              (problem) =>
                Effect.logWarning("Configuration folder rejected", {
                  file: problem.file,
                  message: problem.message,
                }),
              { discard: true },
            ),
          ),
        ),
        export: Effect.fn("ConfigurationFolder.export")(
          function* (root, instance) {
            yield* Effect.annotateCurrentSpan({ directory: root });
            yield* fs.makeDirectory(root, { recursive: true });
            const encoded = Schema.encodeSync(UsineConfig)(instance.config);
            const exported =
              instance.config.version === 1
                ? encoded
                : {
                    ...encoded,
                    repos: encoded.repos.map(({ lanes: _lanes, ...repository }) => repository),
                  };
            yield* fs.writeFileString(path.join(root, "usine.yaml"), writeYaml(exported));
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
            if (instance.config.version === 1) {
              yield* write(
                "loops",
                instance.loops.map((loop) => [loop.name, formatLoop(loop)]),
              );
            } else {
              yield* write("loops", []);
              for (const project of instance.config.projects) {
                yield* write(
                  `projects/${project.id}/loops`,
                  instance.loops
                    .filter((loop) => loop.name.startsWith(`${project.id}/`))
                    .map((loop) => [loop.name.slice(project.id.length + 1), formatLoop(loop)]),
                );
              }
            }
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
