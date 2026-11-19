import { canonicalLabelName } from "@usine/core/label";
import { Option, Schema } from "effect";
import { REMOVED_KEYS } from "../parser.ts";
import {
  ConfigurationChange,
  type ConfigurationEntity,
  type ConfigurationEntityKind,
} from "./model.ts";

/** A stored entity value changed to satisfy the current configuration rules. */
export interface StoredUpgrade {
  /** The change from the stored value to the upgraded value. */
  readonly change: ConfigurationChange;
  /** The outcome labels removed from a loop, or the keys removed from an agent or the settings. */
  readonly removed: ReadonlyArray<string>;
}

const StoredLoop = Schema.Struct({
  trigger: Schema.Struct({ on: Schema.String }),
  outcomeLabels: Schema.Array(Schema.String),
});

/**
 * Returns the upgrades for stored loops that earlier versions accepted and the current rules
 * reject: a schedule loop loses its outcome labels, and an outcome label that repeats an earlier
 * one in a different letter case is removed. Leaves every other entity, and any loop value that
 * doesn't have this shape, to validation.
 */
export const storedLoopUpgrades = (
  entities: ReadonlyArray<ConfigurationEntity>,
): ReadonlyArray<StoredUpgrade> =>
  entities.flatMap(({ key, value }) => {
    if (key.kind !== "loop") return [];
    const fields = Schema.decodeUnknownOption(Schema.JsonObject)(value);
    const loop = Schema.decodeUnknownOption(StoredLoop)(value);
    if (Option.isNone(fields) || Option.isNone(loop)) return [];
    const { trigger, outcomeLabels } = loop.value;
    const seen = new Set<string>();
    const kept: Array<string> = [];
    const removed: Array<string> = [];
    for (const label of outcomeLabels) {
      const canonical = canonicalLabelName(label);
      if (trigger.on === "schedule" || seen.has(canonical)) removed.push(label);
      else kept.push(label);
      seen.add(canonical);
    }
    if (removed.length === 0) return [];
    return [
      {
        change: ConfigurationChange.make({
          key,
          before: Option.some(value),
          after: Option.some({ ...fields.value, outcomeLabels: kept }),
        }),
        removed,
      },
    ];
  });

const jsonObject = Schema.decodeUnknownOption(Schema.JsonObject);

const omit = (fields: Schema.JsonObject, keys: ReadonlyArray<string>): Schema.JsonObject =>
  Object.fromEntries(Object.entries(fields).filter(([field]) => !keys.includes(field)));

/** The keys of a stored agent value that earlier versions wrote for `REMOVED_KEYS`. */
const REMOVED_AGENT_KEYS = ["coordinator", "parentModel", "parentEffort"] as const;

/**
 * Returns `value` without the keys that usine ignores, with the keys removed: an
 * agent's `coordinator`, `parentModel`, and `parentEffort`, or `REMOVED_KEYS` in the settings
 * block. Returns `None` if the value has none of them.
 */
const removeKeys = (
  kind: ConfigurationEntityKind,
  value: Schema.Json,
): Option.Option<{
  readonly value: Schema.JsonObject;
  readonly removed: ReadonlyArray<string>;
}> => {
  const fields = jsonObject(value);
  if (Option.isNone(fields)) return Option.none();
  if (kind === "agent") {
    const removed = REMOVED_AGENT_KEYS.filter((key) => Object.hasOwn(fields.value, key));
    return removed.length === 0
      ? Option.none()
      : Option.some({ value: omit(fields.value, removed), removed });
  }
  if (kind !== "settings") return Option.none();
  const settings = jsonObject(fields.value.settings);
  if (Option.isNone(settings)) return Option.none();
  const removed = REMOVED_KEYS.filter((key) => Object.hasOwn(settings.value, key));
  return removed.length === 0
    ? Option.none()
    : Option.some({ value: { ...fields.value, settings: omit(settings.value, removed) }, removed });
};

/** Returns a stored `value` of an entity of `kind` without the keys that usine ignores. */
export const withoutRemovedKeys = (
  kind: ConfigurationEntityKind,
  value: Schema.Json,
): Schema.Json =>
  Option.match(removeKeys(kind, value), {
    onNone: () => value,
    onSome: (upgraded) => upgraded.value,
  });

/**
 * Returns the upgrades for stored agent and settings values that still have the coordinator,
 * parent model, or parent effort keys of earlier versions.
 */
export const removedKeyUpgrades = (
  entities: ReadonlyArray<ConfigurationEntity>,
): ReadonlyArray<StoredUpgrade> =>
  entities.flatMap((entity) =>
    Option.match(removeKeys(entity.key.kind, entity.value), {
      onNone: () => [],
      onSome: ({ value, removed }) => [
        {
          change: ConfigurationChange.make({
            key: entity.key,
            before: Option.some(entity.value),
            after: Option.some(value),
          }),
          removed,
        },
      ],
    }),
  );
