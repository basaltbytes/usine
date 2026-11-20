import { type CredentialHolderOf, WorkerCredentialHolder } from "@usine/core/worker";
import { Context, Effect } from "effect";

/**
 * Reads who holds the credential that each harness uses on each Worker, which keys the capacity
 * groups. The orchestrator provides the holders of its declared Workers; without them, each
 * Worker holds the credentials of its harnesses.
 */
export const CredentialHolders = Context.Reference<{
  /** Reads the current holders, which a configuration reload can change. */
  readonly current: Effect.Effect<CredentialHolderOf>;
}>("@usine/engine/CredentialHolders", {
  defaultValue: () => ({
    current: Effect.succeed((worker) => WorkerCredentialHolder.make({ worker })),
  }),
});
