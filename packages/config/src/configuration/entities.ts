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
  const next = new Map(after.map((entry) => [entry.key.key, entry]));
  return [...new Set([...previous.keys(), ...next.keys()])].flatMap((key) => {
    const old = previous.get(key);
    const value = next.get(key);
    const identity = value ?? old;
    if (identity === undefined || Equal.equals(old?.value, value?.value)) return [];
    return [
      new ConfigurationChange({
        key: identity.key,
        before: Option.fromUndefinedOr(old?.value),
        after: Option.fromUndefinedOr(value?.value),
      }),
    ];
  });
};
