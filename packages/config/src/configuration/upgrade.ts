import { canonicalLabelName } from "@usine/core/label";
import { Option, Schema } from "effect";
import { ConfigurationChange, type ConfigurationEntity } from "./model.ts";

/** A stored loop value changed to satisfy the current loop rules. */
export interface StoredLoopUpgrade {
  /** The change from the stored value to the upgraded value. */
  readonly change: ConfigurationChange;
  /** The outcome labels removed from the loop. */
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
): ReadonlyArray<StoredLoopUpgrade> =>
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
