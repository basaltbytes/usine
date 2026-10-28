import { Equal, Option, Schema } from "effect";
import { AgentFile } from "../agent.ts";
import { UsineConfig } from "../factory.ts";
import type { LoadedInstance } from "../instance/instance.ts";
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
  new ConfigurationEntity({
    key: new ConfigurationEntityKey({ kind, identifier: ConfigurationEntityId.make(identifier) }),
    value,
  });

export const configurationEntities = (
  instance: LoadedInstance,
): ReadonlyArray<ConfigurationEntity> => {
  const { workers, repos, labels, ...settings } = Schema.encodeSync(UsineConfig)(instance.config);
  return [
    entity("settings", "instance", settings),
    ...(workers ?? []).map((value) => entity("worker", value.name, value)),
    ...repos.map((value) => entity("repository", value.name, value)),
    ...(labels ?? []).map((value) => entity("label", value.name, value)),
    ...instance.agents.map((value) =>
      entity("agent", value.name, Schema.encodeSync(AgentJson)(value)),
    ),
    ...instance.loops.map((value) =>
      entity("loop", value.name, Schema.encodeSync(LoopJson)(value)),
    ),
  ];
};

export const configurationDiff = (
  before: ReadonlyArray<ConfigurationEntity>,
  after: ReadonlyArray<ConfigurationEntity>,
): ReadonlyArray<ConfigurationChange> => {
  const previous = new Map(before.map((entry) => [entry.key.key, entry]));
  const next = new Set(after.map(({ key }) => key.key));
  const previousOrder = new Map(
    before.filter(({ key }) => next.has(key.key)).map(({ key }, index) => [key.key, index]),
  );
  const nextOrder = new Map(
    after.filter(({ key }) => previous.has(key.key)).map(({ key }, index) => [key.key, index]),
  );
  const removed = before
    .filter(({ key }) => !next.has(key.key))
    .map(
      ({ key, value }) =>
        new ConfigurationChange({ key, before: Option.some(value), after: Option.none() }),
    );
  const changed = after.flatMap((entry, position) => {
    const old = previous.get(entry.key.key);
    const moved =
      old === undefined || previousOrder.get(entry.key.key) !== nextOrder.get(entry.key.key);
    if (!moved && Equal.equals(old?.value, entry.value)) return [];
    const change = {
      key: entry.key,
      before: Option.fromUndefinedOr(old?.value),
      after: Option.some(entry.value),
    };
    return [new ConfigurationChange(moved ? { ...change, position } : change)];
  });
  return [...removed, ...changed];
};
