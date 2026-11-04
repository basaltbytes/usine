import { Effect, Equal, Option, Schema } from "effect";
import { AgentFile } from "../agent.ts";
import { UsineConfig } from "../factory.ts";
import type { LoadedInstance } from "../instance/instance.ts";
import { ConfigFileError, InstancePath } from "../file.ts";
import { ConfigurationInvalid } from "./model.ts";
import { LoopFile } from "../loop.ts";
import {
  ConfigurationChange,
  ConfigurationEntity,
  ConfigurationEntityId,
  ConfigurationEntityKey,
  type ConfigurationEntityKind,
} from "./model.ts";

export const AgentJson = Schema.toCodecJson(AgentFile);
export const LoopJson = Schema.toCodecJson(LoopFile);

const entity = (kind: ConfigurationEntityKind, identifier: string, value: Schema.Json) =>
  ConfigurationEntity.make({
    key: ConfigurationEntityKey.make({ kind, identifier: ConfigurationEntityId.make(identifier) }),
    value,
  });

/**
 * Encodes `instance` as configuration entities with defaults applied. Worker order preserves
 * scheduling preference; settings use the singleton identifier `instance`.
 */
export const configurationEntities = Effect.fn("Configuration.entities")(
  function* (instance: LoadedInstance) {
    const { workers, repos, labels, projects, bindings, ...settings } = yield* Schema.encodeEffect(
      UsineConfig,
    )(instance.config);
    return [
      entity("settings", "instance", settings),
      ...(bindings ?? []).map((value) => entity("binding", value.name, value)),
      ...(workers ?? []).map((value) => entity("worker", value.name, value)),
      ...repos.map(({ lanes, ...value }) =>
        entity(
          "repository",
          value.name,
          instance.config.version === 1 ? { ...value, lanes: lanes ?? [] } : value,
        ),
      ),
      ...(projects ?? []).map((value) => entity("project", value.id, value)),
      ...(labels ?? []).map((value) => entity("label", value.name, value)),
      ...(yield* Effect.forEach(instance.agents, (value) =>
        Schema.encodeEffect(AgentJson)(value).pipe(
          Effect.map((json) => entity("agent", value.name, json)),
        ),
      )),
      ...(yield* Effect.forEach(instance.loops, (value) =>
        Schema.encodeEffect(LoopJson)(value).pipe(
          Effect.map((json) => entity("loop", value.name, json)),
        ),
      )),
    ];
  },
  Effect.mapError((error) =>
    ConfigurationInvalid.make({
      problems: [ConfigFileError.fromSchema(InstancePath.make("usine.yaml"), error)],
    }),
  ),
);

/**
 * Returns changes from `before` to `after`, comparing values and the relative order of retained
 * workers. Other entity order changes are ignored; worker positions are zero-based among workers
 * in `after`.
 */
export const configurationDiff = (
  before: ReadonlyArray<ConfigurationEntity>,
  after: ReadonlyArray<ConfigurationEntity>,
): ReadonlyArray<ConfigurationChange> => {
  const previous = new Map(before.map((entry) => [entry.key.key, entry]));
  const next = new Set(after.map(({ key }) => key.key));
  const previousOrder = new Map(
    before
      .filter(({ key }) => key.kind === "worker" && next.has(key.key))
      .map(({ key }, index) => [key.key, index]),
  );
  const nextOrder = new Map(
    after
      .filter(({ key }) => key.kind === "worker" && previous.has(key.key))
      .map(({ key }, index) => [key.key, index]),
  );
  const removed = before
    .filter(({ key }) => !next.has(key.key))
    .map(({ key, value }) =>
      ConfigurationChange.make({ key, before: Option.some(value), after: Option.none() }),
    );
  let workerPosition = 0;
  const changed = after.flatMap((entry) => {
    const position = entry.key.kind === "worker" ? workerPosition++ : undefined;
    const old = previous.get(entry.key.key);
    const moved =
      position !== undefined &&
      (old === undefined || previousOrder.get(entry.key.key) !== nextOrder.get(entry.key.key));
    if (!moved && Equal.equals(old?.value, entry.value)) return [];
    const change = {
      key: entry.key,
      before: Option.fromUndefinedOr(old?.value),
      after: Option.some(entry.value),
    };
    return [ConfigurationChange.make(moved ? { ...change, position } : change)];
  });
  return [...removed, ...changed];
};

/**
 * Resolves `key` against `entities`. A unique short loop name becomes qualified; a new short name
 * needs exactly one project, or stays unqualified with no projects. Returns `None` for ambiguity
 * and leaves other keys unchanged.
 */
export const resolveConfigurationEntityKey = (
  entities: ReadonlyArray<ConfigurationEntity>,
  key: ConfigurationEntityKey,
): Option.Option<ConfigurationEntityKey> => {
  if (key.kind !== "loop" || key.identifier.includes("/")) return Option.some(key);
  const matches = entities.filter(
    (entry) =>
      entry.key.kind === "loop" &&
      (entry.key.identifier === key.identifier ||
        entry.key.identifier.endsWith(`/${key.identifier}`)),
  );
  if (matches.length === 1) return Option.fromUndefinedOr(matches[0]?.key);
  if (matches.length > 1) return Option.none();
  const projects = entities.filter((entry) => entry.key.kind === "project");
  const project = projects[0];
  if (projects.length === 1 && project !== undefined)
    return Option.some(
      ConfigurationEntityKey.make({
        kind: "loop",
        identifier: ConfigurationEntityId.make(`${project.key.identifier}/${key.identifier}`),
      }),
    );
  return projects.length === 0 ? Option.some(key) : Option.none();
};

/**
 * Replaces a loop JSON object's short `name` with `key.identifier` when they match. Returns other
 * entity values and mismatched names unchanged.
 */
export const qualifyLoopValue = (key: ConfigurationEntityKey, value: Schema.Json): Schema.Json => {
  if (key.kind !== "loop") return value;
  return Option.match(Schema.decodeUnknownOption(Schema.JsonObject)(value), {
    onNone: () => value,
    onSome: (fields) =>
      fields.name === key.identifier.split("/").at(-1)
        ? { ...fields, name: key.identifier }
        : value,
  });
};
