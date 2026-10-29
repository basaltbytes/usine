import { OperatorLogin } from "@usine/core/operator";
import { Context, type Effect, type Option, type Stream } from "effect";
import {
  Configuration,
  ConfigurationChange,
  ConfigurationEntityKey,
  ConfigurationInvalid,
  ConfigurationRevision,
  ConfigurationRevisionNumber,
  ConfigurationStoreError,
  StaleRevision,
} from "./model.ts";

export interface ConfigurationCommit {
  readonly expected: ConfigurationRevisionNumber;
  readonly changes: ReadonlyArray<ConfigurationChange>;
  readonly actor: Option.Option<OperatorLogin>;
  readonly message: Option.Option<string>;
}

export class ConfigurationStore extends Context.Service<
  ConfigurationStore,
  {
    readonly read: Effect.Effect<Configuration, ConfigurationStoreError>;
    readonly list: (
      entity: Option.Option<ConfigurationEntityKey>,
    ) => Effect.Effect<ReadonlyArray<ConfigurationRevision>, ConfigurationStoreError>;
    readonly revision: (
      number: ConfigurationRevisionNumber,
    ) => Effect.Effect<Option.Option<ConfigurationRevision>, ConfigurationStoreError>;
    readonly commit: (
      request: ConfigurationCommit,
    ) => Effect.Effect<
      ConfigurationRevision,
      StaleRevision | ConfigurationInvalid | ConfigurationStoreError
    >;
    /** Replays every revision after `number`, then follows commits from any connection. */
    readonly changes: (
      number: ConfigurationRevisionNumber,
    ) => Stream.Stream<ConfigurationRevision, ConfigurationStoreError>;
  }
>()("@usine/config/ConfigurationStore") {}

export {
  Configuration,
  ConfigurationChange,
  ConfigurationEntity,
  ConfigurationEntityId,
  ConfigurationEntityKey,
  ConfigurationEntityKind,
  ConfigurationInvalid,
  ConfigurationRevision,
  ConfigurationRevisionNumber,
  ConfigurationRevertBlocked,
  ConfigurationStoreError,
  StaleRevision,
} from "./model.ts";
export { commit, validateConfiguration } from "./commit.ts";
export {
  configurationDiff,
  configurationEntities,
  resolveConfigurationEntityKey,
  qualifyLoopValue,
} from "./entities.ts";

export { revertConfiguration } from "./revert.ts";
