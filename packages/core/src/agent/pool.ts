import { type Brand, Context, Schema } from "effect";

/**
 * The ID of a billing pool, such as `apiKeys` (ADR 0013). It validates ID syntax without fixing the
 * set of pools; the harness catalog in `@usine/agents/harness` declares them.
 */
export const BillingPool = Schema.String.check(
  Schema.isPattern(/^[a-z][a-zA-Z0-9]*$/u, { message: "Expected a camelCase billing pool ID" }),
).pipe(Schema.brand("BillingPool"));
export type BillingPool = typeof BillingPool.Type;

/** `plan` for a subscription with usage limits; `metered` for usage billed per token. */
export const PoolBilling = Schema.Literals(["plan", "metered"]);
export type PoolBilling = typeof PoolBilling.Type;

/**
 * How harnesses report a pool's plan windows: `none` reports no windows, `together` reports every
 * window of the plan in each report, and `separately` reports one window at a time, so a report
 * that omits a window leaves that window's last reading in place.
 */
export const PlanWindows = Schema.Literals(["none", "together", "separately"]);
export type PlanWindows = typeof PlanWindows.Type;

/** A billing pool that a harness descriptor declares. */
export class PoolDescriptor extends Schema.Class<
  PoolDescriptor,
  Brand.Brand<"@usine/core/agent/pool/PoolDescriptor">
>("Agent/PoolDescriptor")(
  Schema.Struct({
    id: BillingPool,
    /** The display name, such as `API keys`. */
    label: Schema.NonEmptyString,
    billing: PoolBilling,
    windows: PlanWindows,
  }).check(
    Schema.makeFilter(
      ({ billing, windows }) =>
        billing === "plan" || windows === "none" || "A metered pool has no plan windows",
    ),
  ),
) {}

/**
 * The billing pools that the harness catalog declares, in catalog order. The server provides the
 * catalog's pools; a test provides the pools that it declares.
 */
export class BillingPools extends Context.Service<BillingPools, ReadonlyArray<PoolDescriptor>>()(
  "@usine/core/agent/pool/BillingPools",
) {}

/**
 * Returns the pool of `pools` with ID `id`. For a pool that `pools` doesn't declare, such as one of
 * a removed harness, returns a metered pool without plan windows that is labelled with its ID.
 */
export const declaredPool = (
  pools: ReadonlyArray<PoolDescriptor>,
  id: BillingPool,
): PoolDescriptor =>
  pools.find((pool) => pool.id === id) ??
  PoolDescriptor.make({ id, label: id, billing: "metered", windows: "none" });
