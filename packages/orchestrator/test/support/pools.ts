import { catalog } from "@usine/agents/harness";
import { BillingPools } from "@usine/core/agent/pool";
import { Layer } from "effect";

/** The billing pools that the harness catalog declares, as the server provides them. */
export const catalogPools = Layer.succeed(BillingPools)(catalog.pools);
