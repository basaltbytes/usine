import { Array as Arr, Effect, Option } from "effect";
import type { ConfigParser } from "../parser.ts";
import { commit } from "./commit.ts";
import { configurationEntities } from "./entities.ts";
import {
  Configuration,
  ConfigurationChange,
  ConfigurationRevertBlocked,
  type ConfigurationRevision,
} from "./model.ts";

/** Restores values and worker positions, refusing to overwrite later changes to the same entities. */
export const revertConfiguration = (
  parser: ConfigParser["Service"],
  target: ConfigurationRevision,
  history: ReadonlyArray<ConfigurationRevision>,
) =>
  Effect.gen(function* () {
    const later = new Set(
      history
        .filter(({ number }) => number > target.number)
        .flatMap(({ changes }) => changes.map(({ key }) => key.key)),
    );
    const conflicts = target.changes.filter(({ key }) => later.has(key.key)).map(({ key }) => key);
    if (Arr.isArrayNonEmpty(conflicts))
      return yield* new ConfigurationRevertBlocked({ entities: conflicts });

    let previous = Configuration.empty;
    for (const entry of history
      .filter(({ number }) => number < target.number)
      .sort((a, b) => a.number - b.number)) {
      previous = (yield* commit(parser, previous, previous.number, entry.changes, entry))
        .configuration;
    }
    const entities = Option.match(previous.instance, {
      onNone: () => [],
      onSome: configurationEntities,
    });
    const positions = new Map(
      entities
        .filter(({ key }) => key.kind === "worker")
        .map(({ key }, position) => [key.key, position]),
    );
    return target.changes.map((change) => {
      const position = positions.get(change.key.key);
      const reversed = { key: change.key, before: change.after, after: change.before };
      return new ConfigurationChange(position === undefined ? reversed : { ...reversed, position });
    });
  });
