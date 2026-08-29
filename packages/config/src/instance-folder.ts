import { Instance } from "@usine/core";
import { Context, Effect, FileSystem, Layer, Option, Path, Result } from "effect";
import {
  type AgentFile,
  type AgentName,
  ConfigFileError,
  FactoryConfigError,
  InstancePath,
  InvalidAgent,
  LoadedInstance,
  type LoopFile,
  QuarantinedLoop,
  type RegistryTag,
  type RepoName,
} from "./model.ts";
import { ConfigParser } from "./parser.ts";

const FILE_CONCURRENCY = 16;

interface ParsedFile<A> {
  readonly file: InstancePath;
  readonly result: Result.Result<A, ConfigFileError>;
}

interface ReferenceIndex {
  readonly agentNames: ReadonlySet<AgentName>;
  readonly registryTags: ReadonlySet<RegistryTag>;
  readonly repoNames: ReadonlySet<RepoName>;
}

const factoryError = (error: ConfigFileError): FactoryConfigError =>
  new FactoryConfigError({
    file: error.file,
    stage: error.stage,
    message: error.message,
  });

const referenceError = (file: InstancePath, message: string): ConfigFileError =>
  new ConfigFileError({ file, stage: "reference", message });

const validateReferences = (
  file: InstancePath,
  loop: LoopFile,
  references: ReferenceIndex,
): Option.Option<ConfigFileError> => {
  if (!references.agentNames.has(loop.agent)) {
    return Option.some(referenceError(file, `Unknown agent: ${loop.agent}`));
  }

  if (Option.isNone(loop.selector)) return Option.none();
  if (Option.isSome(loop.selector.value.repos)) {
    const missing = loop.selector.value.repos.value.filter(
      (name) => !references.repoNames.has(name),
    );
    if (missing.length > 0) {
      return Option.some(referenceError(file, `Unknown selector repos: ${missing.join(", ")}`));
    }
  }

  if (Option.isSome(loop.selector.value.tags)) {
    const missing = loop.selector.value.tags.value.filter(
      (tag) => !references.registryTags.has(tag),
    );
    if (missing.length > 0) {
      return Option.some(referenceError(file, `Unknown selector tags: ${missing.join(", ")}`));
    }
  }
  return Option.none();
};

/** End-to-end instance-folder loader with factory failure and per-loop quarantine. */
export class InstanceFolder extends Context.Service<
  InstanceFolder,
  {
    readonly load: (root: Instance.Directory) => Effect.Effect<LoadedInstance, FactoryConfigError>;
  }
>()("@usine/config/InstanceFolder") {
  static readonly layer = Layer.effect(
    InstanceFolder,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parser = yield* ConfigParser;

      const readFile = Effect.fn("InstanceFolder.readFile")(
        (absolutePath: string, file: InstancePath): Effect.Effect<string, ConfigFileError> =>
          fileSystem
            .readFileString(absolutePath)
            .pipe(
              Effect.mapError(
                (error) => new ConfigFileError({ file, stage: "read", message: error.message }),
              ),
            ),
      );

      const markdownFiles = Effect.fn("InstanceFolder.markdownFiles")(
        (
          root: Instance.Directory,
          directory: "agents" | "loops",
        ): Effect.Effect<ReadonlyArray<string>, FactoryConfigError> =>
          fileSystem.readDirectory(path.join(root, directory)).pipe(
            Effect.map((files) => files.filter((file) => file.endsWith(".md")).sort()),
            Effect.mapError(
              (error) =>
                new FactoryConfigError({
                  file: InstancePath.make(directory),
                  stage: "read",
                  message: error.message,
                }),
            ),
          ),
      );

      const loadMarkdownFiles = <A>(
        root: Instance.Directory,
        directory: "agents" | "loops",
        parseFile: (file: InstancePath, source: string) => Effect.Effect<A, ConfigFileError>,
      ): Effect.Effect<ReadonlyArray<ParsedFile<A>>, FactoryConfigError> =>
        Effect.gen(function* () {
          const files = yield* markdownFiles(root, directory);
          return yield* Effect.forEach(
            files,
            (name) => {
              const file = InstancePath.make(`${directory}/${name}`);
              return readFile(path.join(root, file), file).pipe(
                Effect.flatMap((source) => parseFile(file, source)),
                Effect.result,
                Effect.map((result): ParsedFile<A> => ({ file, result })),
              );
            },
            { concurrency: FILE_CONCURRENCY },
          );
        });

      return {
        load: Effect.fn("InstanceFolder.load")(
          (root: Instance.Directory): Effect.Effect<LoadedInstance, FactoryConfigError> =>
            Effect.gen(function* () {
              const configFile = InstancePath.make("usine.yaml");
              const configSource = yield* readFile(path.join(root, configFile), configFile).pipe(
                Effect.mapError(factoryError),
              );
              const config = yield* parser
                .parseUsineYaml(configFile, configSource)
                .pipe(Effect.mapError(factoryError));
              const parsed = yield* Effect.all(
                {
                  agents: loadMarkdownFiles(root, "agents", parser.parseAgentFile),
                  loops: loadMarkdownFiles(root, "loops", parser.parseLoopFile),
                },
                { concurrency: 2 },
              );

              const agents: Array<AgentFile> = [];
              const invalidAgents: Array<InvalidAgent> = [];
              for (const entry of parsed.agents) {
                if (Result.isSuccess(entry.result)) agents.push(entry.result.success);
                else {
                  invalidAgents.push(
                    new InvalidAgent({ file: entry.file, error: entry.result.failure }),
                  );
                }
              }

              const references: ReferenceIndex = {
                agentNames: new Set(agents.map(({ name }) => name)),
                registryTags: new Set(config.repos.flatMap(({ tags }) => tags)),
                repoNames: new Set(config.repos.map(({ name }) => name)),
              };

              const loops: Array<LoopFile> = [];
              const quarantinedLoops: Array<QuarantinedLoop> = [];
              for (const entry of parsed.loops) {
                if (Result.isFailure(entry.result)) {
                  quarantinedLoops.push(
                    new QuarantinedLoop({ file: entry.file, error: entry.result.failure }),
                  );
                  continue;
                }
                const referenceFailure = validateReferences(
                  entry.file,
                  entry.result.success,
                  references,
                );
                if (Option.isSome(referenceFailure)) {
                  quarantinedLoops.push(
                    new QuarantinedLoop({ file: entry.file, error: referenceFailure.value }),
                  );
                } else loops.push(entry.result.success);
              }

              return new LoadedInstance({
                config,
                agents,
                invalidAgents,
                loops,
                quarantinedLoops,
              });
            }),
        ),
      };
    }),
  );
}
