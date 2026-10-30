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

/** A request to apply entity changes against an expected current revision. */
export interface ConfigurationCommit {
  /** The revision read before preparing changes; a mismatch fails with `StaleRevision`. */
  readonly expected: ConfigurationRevisionNumber;
  /** The proposed entity changes, including expected before values and any worker positions. */
  readonly changes: ReadonlyArray<ConfigurationChange>;
  /** The operator login to attribute to the revision, or `None` when unavailable. */
  readonly actor: Option.Option<OperatorLogin>;
  /** The optional description to record with the revision. */
  readonly message: Option.Option<string>;
}

/**
 * Versioned configuration reads and atomic validated commits with optimistic concurrency (ADR
 * 0031).
 */
export class ConfigurationStore extends Context.Service<
  ConfigurationStore,
  {
    /** Reads the current validated snapshot, or `Configuration.empty` before initialization. */
    readonly read: Effect.Effect<Configuration, ConfigurationStoreError>;
    /**
     * Lists revisions in ascending number order; `entity` restricts results to changes to that
     * key, while `None` returns all revisions.
     */
    readonly list: (
      entity: Option.Option<ConfigurationEntityKey>,
    ) => Effect.Effect<ReadonlyArray<ConfigurationRevision>, ConfigurationStoreError>;
    /** Reads revision `number`, returning `None` if it does not exist. */
    readonly revision: (
      number: ConfigurationRevisionNumber,
    ) => Effect.Effect<Option.Option<ConfigurationRevision>, ConfigurationStoreError>;
    /**
     * Atomically validates and applies `request`, assigns the next revision and current time, and
     * records normalized changes. Rejects stale revisions or invalid candidates without modifying
     * the store.
     */
    readonly commit: (
      request: ConfigurationCommit,
    ) => Effect.Effect<
      ConfigurationRevision,
      StaleRevision | ConfigurationInvalid | ConfigurationStoreError
    >;
    /**
     * Replays revisions strictly after `number` in ascending order, then follows commits from any
     * connection. Polls every 500 ms while idle; cancel the stream to stop watching.
     */
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
