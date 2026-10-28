import type { AttemptId } from "@usine/core/attempt";
import type { RunId } from "@usine/core/run";
import {
  type MachineId,
  MachineProvider,
  type SshDestination,
  type SshPort,
  type WorkerName,
} from "@usine/core/worker";
import type { DateTime, Effect, Option } from "effect";
import { Schema } from "effect";
import type { MachineUnavailableError, WorkerCapabilityError } from "../../executor.ts";

/**
 * What identifies a machine at its provider, so a later process finds it: the usine instance,
 * the Worker, the Run it was created for, the process that created it, and the Attempt it runs.
 */
export interface MachineTags {
  readonly instance: string;
  readonly worker: WorkerName;
  readonly run: RunId;
  readonly process: string;
  readonly attempt: AttemptId;
}

/** The tags of a machine as its provider lists them, each encoded by `tagValue`. */
interface ListedTags {
  readonly worker: string;
  readonly run: string;
  readonly process: string;
  /** `None` for an orphan created by an older release. */
  readonly attempt: Option.Option<string>;
}

/** A machine that a provider lists for this instance and Worker. */
export interface ListedMachine {
  readonly id: MachineId;
  readonly tags: ListedTags;
  readonly createdAt: DateTime.Utc;
}

/** Where the executor reaches a machine over SSH. */
export interface MachineEndpoint {
  /** `user@address`. */
  readonly destination: SshDestination;
  readonly port: Option.Option<SshPort>;
  /**
   * The machine's SSH host key that the provider's API reports, as `known_hosts` writes it, or
   * `None` if the driver set the key when it created the machine (`CreatedMachine.hostKey`).
   */
  readonly hostKey: Option.Option<string>;
}

/** A machine that a provider accepted to create. */
interface CreatedMachine {
  readonly id: MachineId;
  /** The SSH host key that the driver gave the machine, or `None` if the provider sets one. */
  readonly hostKey: Option.Option<string>;
}

/** The error of a provider API request other than a creation. Contains no token. */
export class ProviderApiError extends Schema.TaggedError<ProviderApiError>(
  "@usine/executor/ProviderApiError",
)("ProviderApiError", {
  provider: MachineProvider,
  operation: Schema.String,
  /** The HTTP status, or `None` if the API didn't respond. */
  status: Schema.Option(Schema.Int),
  message: Schema.NonEmptyString,
}) {}

/** What a provider's preflight found that doesn't stop `usine up`, such as an out-of-stock server type. */
interface DriverReport {
  readonly warnings: ReadonlyArray<string>;
}

/** One provider's API for the machines of a provisioned Worker. */
export interface MachineDriver {
  readonly provider: MachineProvider;
  /**
   * Checks the provider token, and that the image, SSH key, network, and machine type exist.
   * Reads the account's limits where the API offers them.
   */
  readonly verify: (
    worker: WorkerName,
    maxConcurrentAttempts: number,
  ) => Effect.Effect<DriverReport, WorkerCapabilityError>;
  /** Creates a machine named `name` with `tags` once the provider accepts it. */
  readonly create: (
    name: string,
    tags: MachineTags,
  ) => Effect.Effect<CreatedMachine, MachineUnavailableError>;
  /** Waits until the machine runs and has an SSH address. Polls every `interval`. */
  readonly endpoint: (
    id: MachineId,
    interval: Effect.Effect<void>,
  ) => Effect.Effect<MachineEndpoint, MachineUnavailableError>;
  /** Deletes the machine. A machine that is already gone counts as deleted. */
  readonly remove: (id: MachineId) => Effect.Effect<void, ProviderApiError>;
  /** Lists machines tagged with `instance`, optionally limited to one Worker. */
  readonly list: (
    instance: string,
    worker: Option.Option<WorkerName>,
  ) => Effect.Effect<ReadonlyArray<ListedMachine>, ProviderApiError>;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** Returns the 64-bit FNV-1a hash of `text`'s UTF-8 bytes as 16 hex digits. */
const fnv1a64 = (text: string): string => {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
};

const TAG_SAFE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u;

/**
 * Returns `value` as a tag value of at most `maxLength` characters: `value` itself if it fits
 * and uses only letters, digits, `_`, `.`, and `-`, else its 16-digit hash prefixed with `h`.
 */
export const tagValue = (value: string, maxLength = 63): string =>
  value.length <= maxLength && TAG_SAFE.test(value) ? value : `h${fnv1a64(value)}`;

/** Returns the tag value of an Attempt: the hash of its ID, since Attempt IDs contain `/`. */
export const attemptTag = (attemptId: AttemptId): string => `h${fnv1a64(attemptId)}`;

/** Returns a machine name: `usine-<worker>-<suffix>`, at most 63 characters, valid as a host name. */
export const machineName = (worker: WorkerName, suffix: string): string => {
  const head = `usine-${worker}`.slice(0, 63 - suffix.length - 1).replace(/-+$/u, "");
  return `${head}-${suffix}`;
};
