import { Array as Arr, Effect, Equal, Option, Result, Schema } from "effect";
import type { UsineConfig } from "../factory.ts";
import { AgentFile } from "../agent.ts";
import { ConfigFileError, InstancePath } from "../file.ts";
import { LoadedInstance } from "../instance/instance.ts";
import { loopReferenceFailure, referenceIndex } from "../instance/references.ts";
import { LoopFile, loopPath } from "../loop.ts";
import { type ConfigParser, formatAgent, formatLoop } from "../parser.ts";
import { writeYaml } from "../yaml/writer.ts";
import { AgentJson, LoopJson, configurationEntities } from "./entities.ts";
import {
  Configuration,
  ConfigurationChange,
  ConfigurationEntity,
  ConfigurationInvalid,
  ConfigurationRevision,
  ConfigurationRevisionNumber,
  StaleRevision,
} from "./model.ts";

const problem = (file: string, message: string) =>
  new ConfigFileError({
    file: InstancePath.make(file),
    stage: "schema",
    expression: Option.none(),
    message,
  });

export const configurationWarnings = (
  parser: ConfigParser["Service"],
  config: UsineConfig,
  loops: ReadonlyArray<LoopFile>,
) =>
  parser.configWarnings(config, loops).pipe(
    Effect.mapError(
      (error) =>
        new ConfigurationInvalid({
          problems: [
            new ConfigFileError({
              file: InstancePath.make("usine.yaml"),
              stage: "expression",
              expression: Option.some(error.source),
              message: error.message,
            }),
          ],
        }),
    ),
  );

/** Parses a complete candidate and collects errors before constructing its snapshot. */
export const validateConfiguration = (
  parser: ConfigParser["Service"],
  entities: ReadonlyArray<ConfigurationEntity>,
): Effect.Effect<LoadedInstance, ConfigurationInvalid> =>
  Effect.gen(function* () {
    const problems: Array<ConfigFileError> = [];
    const singleton = entities.filter(({ key }) => key.kind === "settings");
    const settings = singleton[0];
    if (singleton.length !== 1 || settings?.key.identifier !== "instance") {
      problems.push(problem("usine.yaml", "Expected one settings entity named instance"));
    }
    const fields = Schema.decodeUnknownResult(Schema.JsonObject)(settings?.value);
    const values = (kind: ConfigurationEntity["key"]["kind"]) =>
      entities.filter(({ key }) => key.kind === kind).map(({ value }) => value);
    const settingsFields = Result.getOrElse(fields, () => ({}));
    const config = yield* parser
      .parseUsineYaml(
        InstancePath.make("usine.yaml"),
        writeYaml({
          ...settingsFields,
          workers: values("worker"),
          repos: values("repository"),
          labels: values("label"),
        }),
      )
      .pipe(Effect.result);
    if (Result.isFailure(config)) problems.push(config.failure);

    const agents: Array<AgentFile> = [];
    const loops: Array<LoopFile> = [];
    for (const entry of entities) {
      const { kind, identifier } = entry.key;
      if (kind !== "settings") {
        const named = Schema.decodeUnknownResult(Schema.Struct({ name: Schema.NonEmptyString }))(
          entry.value,
        );
        if (Result.isSuccess(named) && named.success.name !== identifier) {
          problems.push(problem(entry.key.key, "Entity identifier does not match its name"));
        }
      }
      if (kind !== "loop" && kind !== "agent") continue;
      const file = InstancePath.make(`${kind}s/${identifier}.md`);
      const parsed = yield* (
        kind === "agent"
          ? Schema.decodeUnknownEffect(AgentJson)(entry.value, {
              errors: "all",
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError((e) => problem(file, e.message)),
              Effect.flatMap((value) => parser.parseAgentFile(file, formatAgent(value))),
              Effect.tap((value) => Effect.sync(() => agents.push(value))),
              Effect.asVoid,
            )
          : Schema.decodeUnknownEffect(LoopJson)(entry.value, {
              errors: "all",
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError((e) => problem(file, e.message)),
              Effect.flatMap((value) => parser.parseLoopFile(file, formatLoop(value))),
              Effect.tap((value) => Effect.sync(() => loops.push(value))),
              Effect.asVoid,
            )
      ).pipe(Effect.result);
      if (Result.isFailure(parsed)) problems.push(parsed.failure);
    }
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
      invalidAgents: [],
      quarantinedLoops: [],
      warnings: yield* configurationWarnings(parser, config.success, loops),
    });
  });

/** A deterministic commit; the caller supplies validation, the actor, and the time. */
export const commit = (
  parser: ConfigParser["Service"],
  current: Configuration,
  expected: ConfigurationRevisionNumber,
  changes: ReadonlyArray<ConfigurationChange>,
  metadata: Pick<ConfigurationRevision, "actor" | "time" | "message">,
): Effect.Effect<
  {
    readonly configuration: Configuration;
    readonly revision: ConfigurationRevision;
  },
  StaleRevision | ConfigurationInvalid
> =>
  Effect.gen(function* () {
    if (current.number !== expected)
      return yield* new StaleRevision({ expected, actual: current.number });
    const entities = new Map(
      Option.match(current.instance, {
        onNone: () => [],
        onSome: configurationEntities,
      }).map((entry) => [entry.key.key, entry]),
    );
    const seen = new Set<string>();
    const problems: Array<ConfigFileError> = [];
    for (const change of changes) {
      const previous = Option.fromUndefinedOr(entities.get(change.key.key)?.value);
      if (seen.has(change.key.key) || !Equal.equals(previous, change.before)) {
        problems.push(
          problem(
            change.key.key,
            "Duplicate change or before value does not match the current configuration",
          ),
        );
      }
      seen.add(change.key.key);
      if (Option.isNone(change.after)) entities.delete(change.key.key);
      else
        entities.set(
          change.key.key,
          new ConfigurationEntity({ key: change.key, value: change.after.value }),
        );
    }
    if (Arr.isArrayNonEmpty(problems)) return yield* new ConfigurationInvalid({ problems });
    const instance = yield* validateConfiguration(parser, [...entities.values()]);
    const number = ConfigurationRevisionNumber.make(current.number + 1);
    return {
      configuration: new Configuration({ number, instance: Option.some(instance) }),
      revision: new ConfigurationRevision({ ...metadata, number, changes }),
    };
  });
