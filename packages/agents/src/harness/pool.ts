import { BillingPool, PoolDescriptor } from "@usine/core/agent/pool";
import { type Brand, Schema } from "effect";
import { CredentialRoute } from "./capability.ts";

/** The pool of usage billed per token to a provider API key, on any harness. */
export const apiKeys = PoolDescriptor.make({
  id: BillingPool.make("apiKeys"),
  label: "API keys",
  billing: "metered",
  windows: "none",
});

/**
 * A billing pool that a harness's sessions can use, with the credential routes that determine it
 * at admission. On a route that no pool lists, the harness reports the pool at launch.
 */
export class HarnessPool extends Schema.Class<
  HarnessPool,
  Brand.Brand<"@usine/agents/harness/HarnessPool">
>("@usine/agents/HarnessPool")({
  pool: PoolDescriptor,
  routes: Schema.Array(CredentialRoute).check(Schema.isUnique()),
}) {}
