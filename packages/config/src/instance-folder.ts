import { InstanceDirectory } from "@usine/core/instance";
import { Context, Effect, FileSystem, Layer, Option, Path, Result } from "effect";
import { type AgentFile, InvalidAgent } from "./agent.ts";
import { ConfigFileError, FactoryConfigError, InstancePath } from "./file.ts";
import { LoadedInstance } from "./instance/instance.ts";
import { type LoopFile, QuarantinedLoop } from "./loop.ts";
import { loopReferenceFailure, referenceIndex } from "./instance/references.ts";
import { ConfigParser } from "./parser.ts";

const FILE_CONCURRENCY = 16;

interface ParsedFile<A> {
  readonly file: InstancePath;
  readonly result: Result.Result<A, ConfigFileError>;
}

const factoryError = (error: ConfigFileError): FactoryConfigError =>
  new FactoryConfigError({
    file: error.file,
    stage: error.stage,
    message: error.message,
  });

/**
 * The service that loads an instance folder. An invalid `usine.yaml` fails the load; an invalid
 * loop is quarantined.
 */
export class InstanceFolder extends Context.Service<
  InstanceFolder,
  {
    /**
     * Reads `root` as one snapshot. Invalid agents and loops become diagnostics; registry,
     * settings, or directory-read failures fail the load with `FactoryConfigError`.
     */
    readonly load: (root: InstanceDirectory) => Effect.Effect<LoadedInstance, FactoryConfigError>;
  }
>()("@usine/config/InstanceFolder") {
  /** Provides folder inspection using `FileSystem`, `Path`, and `ConfigParser`. */
  static readonly layer = Layer.effect(
    InstanceFolder,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parser = yield* ConfigParser;

      const readFile = Effect.fn("InstanceFolder.readFile")(
        (absolutePath: string, file: InstancePath): Effect.Effect<string, ConfigFileError> =>
          fileSystem.readFileString(absolutePath).pipe(
            Effect.mapError(
              (error) =>
                new ConfigFileError({
                  file,
                  stage: "read",
                  expression: Option.none(),
                  message: error.message,
                }),
            ),
          ),
      );

      const markdownFiles = Effect.fn("InstanceFolder.markdownFiles")(
        (
          root: InstanceDirectory,
          directory: string,
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
        root: InstanceDirectory,
        directory: string,
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
          (root: InstanceDirectory): Effect.Effect<LoadedInstance, FactoryConfigError> =>
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
                  loops:
                    config.version === 1
                      ? loadMarkdownFiles(root, "loops", parser.parseLoopFile)
                      : Effect.forEach(config.projects, (project) =>
                          loadMarkdownFiles(
                            root,
                            `projects/${project.id}/loops`,
                            parser.parseLoopFile,
                          ),
                        ).pipe(Effect.map((groups) => groups.flat())),
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

              const references = referenceIndex(config, agents);

              const loops: Array<LoopFile> = [];
              const quarantinedLoops: Array<QuarantinedLoop> = [];
              for (const entry of parsed.loops) {
                if (Result.isFailure(entry.result)) {
                  quarantinedLoops.push(
                    new QuarantinedLoop({ file: entry.file, error: entry.result.failure }),
                  );
                  continue;
                }
                const referenceFailure = loopReferenceFailure(
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
              yield* Effect.forEach(
                invalidAgents,
                ({ file, error }) =>
                  Effect.logWarning(
                    "Agent file left out of the roster; Loops that use it are quarantined",
                    { file, stage: error.stage, message: error.message },
                  ),
                { discard: true },
              );
              yield* Effect.forEach(
                quarantinedLoops,
                ({ file, error }) =>
                  Effect.logWarning("Loop quarantined; it opens no Runs until its file is fixed", {
                    file,
                    stage: error.stage,
                    message: error.message,
                    expression: Option.getOrUndefined(error.expression),
                  }),
                { discard: true },
              );
              yield* Effect.annotateCurrentSpan({
                loops: loops.length,
                quarantinedLoops: quarantinedLoops.length,
                invalidAgents: invalidAgents.length,
              });

              const warnings = yield* parser.configWarnings(config, loops).pipe(
                Effect.catch((error) =>
                  Effect.logError(
                    "Config warning analysis failed; loaded the valid instance without warnings",
                    {
                      errorTag: error._tag,
                      expression: error.source,
                      message: error.message,
                    },
                  ).pipe(Effect.as([])),
                ),
              );
              yield* Effect.forEach(
                warnings,
                (warning) =>
                  warning._tag === "UndeclaredLaneLabelWarning"
                    ? Effect.logWarning("Board Lane references an undeclared GitHub label", {
                        repository: warning.repository,
                        lane: warning.lane,
                        label: warning.label,
                      })
                    : Effect.logWarning("Loop trigger references an undeclared GitHub label", {
                        loop: warning.loop,
                        label: warning.label,
                      }),
                { discard: true },
              );

              return new LoadedInstance({
                config,
                agents,
                invalidAgents,
                loops,
                quarantinedLoops,
                warnings,
              });
            }),
        ),
      };
    }),
  );
}
