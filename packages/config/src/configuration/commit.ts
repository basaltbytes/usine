import { Array as Arr, Effect, Equal, Option, Result, Schema } from "effect";
import type { UsineConfig } from "../factory.ts";
import { AgentFile } from "../agent.ts";
import { ConfigFileError, InstancePath } from "../file.ts";
import { LoadedInstance } from "../instance/instance.ts";
import { referenceIndex } from "../instance/references.ts";
import { LoopFile } from "../loop.ts";
import { type ConfigParser, formatAgent } from "../parser.ts";
import { writeYaml } from "../yaml/writer.ts";
import { AgentJson, configurationDiff, configurationEntities } from "./entities.ts";
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
          projects: values("project"),
        }),
      )
      .pipe(Effect.result);
    if (Result.isFailure(config)) {
      const error = config.failure;
      if (error.details === undefined) problems.push(error);
      else
        for (const detail of error.details) {
          const [group, index, ...path] = detail.path;
          const kind =
            group === "projects"
              ? "project"
              : group === "workers"
                ? "worker"
                : group === "repos"
                  ? "repository"
                  : group === "labels"
                    ? "label"
                    : "settings";
          const entity =
            kind === "settings"
              ? settings
              : entities
                  .filter(({ key }) => key.kind === kind)
                  .find((_, position) => position === index);
          problems.push(
            new ConfigFileError({
              ...error,
              file: InstancePath.make(entity?.key.key ?? "settings:instance"),
              message: detail.message,
              details: [{ ...detail, path: kind === "settings" ? detail.path : path }],
            }),
          );
        }
    }

    for (const entry of entities.filter(({ key }) => key.kind === "project")) {
      const value = Schema.decodeUnknownResult(Schema.Struct({ id: Schema.String }))(entry.value);
      if (Result.isSuccess(value) && value.success.id !== entry.key.identifier)
        problems.push(problem(entry.key.key, "Project identifier does not match its id"));
    }
    const agents: Array<AgentFile> = [];
    const loops: Array<LoopFile> = [];
    for (const entry of entities) {
      const { kind, identifier } = entry.key;
      if (kind !== "settings" && kind !== "loop" && kind !== "project") {
        const named = Schema.decodeUnknownResult(Schema.Struct({ name: Schema.NonEmptyString }))(
          entry.value,
        );
        if (Result.isSuccess(named) && named.success.name !== identifier) {
          problems.push(problem(entry.key.key, "Entity identifier does not match its name"));
        }
      }
      if (kind !== "agent") continue;
      const file = InstancePath.make(`agents/${identifier}.md`);
      const parsed = yield* Schema.decodeUnknownEffect(AgentJson)(entry.value, {
        errors: "all",
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError((e) => ConfigFileError.fromSchema(file, e)),
        Effect.flatMap((value) => parser.parseAgentFile(file, formatAgent(value))),
        Effect.result,
      );
      if (Result.isFailure(parsed)) problems.push(parsed.failure);
      else agents.push(parsed.success);
    }
    const references = Result.isSuccess(config)
      ? Option.some(referenceIndex(config.success, agents))
      : Option.none();
    for (const entry of entities.filter(({ key }) => key.kind === "loop")) {
      const checked = yield* parser
        .checkLoopDraft(
          InstancePath.make(`loops/${entry.key.identifier}.md`),
          { value: entry.value },
          references,
        )
        .pipe(Effect.result);
      if (Result.isFailure(checked)) problems.push(checked.failure);
      else {
        problems.push(...checked.success.problems);
        if (Option.isSome(checked.success.loop)) loops.push(checked.success.loop.value);
      }
    }
    if (Arr.isArrayNonEmpty(problems)) return yield* new ConfigurationInvalid({ problems });
    if (Result.isFailure(config))
      return yield* new ConfigurationInvalid({ problems: [config.failure] });
    if (config.success.version === 2) {
      for (const loop of loops) {
        if (!config.success.projects.some(({ id }) => loop.name.startsWith(`${id}/`)))
          problems.push(
            problem(
              `loop:${loop.name}`,
              "Expected a loop identifier in an existing project: project/loop",
            ),
          );
      }
    }
    if (Arr.isArrayNonEmpty(problems)) return yield* new ConfigurationInvalid({ problems });
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
    const before = Option.match(current.instance, {
      onNone: () => [],
      onSome: configurationEntities,
    });
    const entities = new Map(before.map((entry) => [entry.key.key, entry]));
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
    const moves = changes.flatMap(({ key, position }) =>
      position === undefined ? [] : [{ key, position }],
    );
    const moved = new Set(moves.map(({ key }) => key.key));
    const workers = [...entities.values()].filter(({ key }) => key.kind === "worker");
    const ordered = workers.filter(({ key }) => !moved.has(key.key));
    const positions = new Set<number>();
    for (const { key, position } of moves.sort((a, b) => a.position - b.position)) {
      const entity = entities.get(key.key);
      if (
        key.kind !== "worker" ||
        entity === undefined ||
        position >= workers.length ||
        positions.has(position)
      ) {
        problems.push(
          problem(key.key, "Position must be unique and within the resulting worker list"),
        );
        continue;
      }
      positions.add(position);
      ordered.splice(position, 0, entity);
    }
    if (Arr.isArrayNonEmpty(problems)) return yield* new ConfigurationInvalid({ problems });
    const instance = yield* validateConfiguration(parser, [
      ...[...entities.values()].filter(({ key }) => key.kind !== "worker"),
      ...ordered,
    ]);
    if (
      Option.isSome(current.instance) &&
      current.instance.value.config.version === 2 &&
      instance.config.version === 1
    )
      return yield* new ConfigurationInvalid({
        problems: [
          problem(
            "settings:instance",
            "Project configuration cannot revert to version 1; import legacy files to convert them",
          ),
        ],
      });
    const number = ConfigurationRevisionNumber.make(current.number + 1);
    return {
      configuration: new Configuration({ number, instance: Option.some(instance) }),
      revision: new ConfigurationRevision({
        ...metadata,
        number,
        changes: configurationDiff(before, configurationEntities(instance)),
      }),
    };
  });
