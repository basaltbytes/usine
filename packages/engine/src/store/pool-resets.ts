import { InstanceScope } from "@usine/core/access";
import { BillingPools, declaredPool } from "@usine/core/agent/pool";
import type { PoolRateLimitsUpdated } from "@usine/core/agent/session";
import { ChangeBus } from "@usine/core/changes";
import { DateTime, Duration, Effect, FiberMap, Option } from "effect";
import { RunDatabase } from "../database/database.ts";
import { latestPoolRateLimits } from "../run-reader/pool-rate-limits.ts";

/**
 * Schedules an attention change for when each window of the latest pool limits resets. `schedule`
 * replaces one pool's deadlines; closing the scope interrupts the pending notices.
 */
export const poolResetNotices = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const bus = yield* ChangeBus;
  const pools = yield* BillingPools;
  const poolResets = yield* FiberMap.make<string>();

  const schedulePoolResets = Effect.fn("RunStore.schedulePoolResets")(function* (
    event: PoolRateLimitsUpdated,
  ) {
    yield* Effect.annotateCurrentSpan({ pool: event.pool });
    for (const window of ["primary", "secondary"] as const) {
      const key = `${event.pool}:${window}`;
      const limit = event.rateLimits[window];
      if (Option.isNone(limit) && declaredPool(pools, event.pool).windows === "separately") {
        yield* Effect.logDebug("Window unreported; keeping its pool reset deadline", {
          pool: event.pool,
          window,
        });
        continue;
      }
      yield* FiberMap.remove(poolResets, key);
      if (Option.isNone(limit) || Option.isNone(limit.value.resetsAt)) {
        yield* Effect.logDebug("Pool reset has no deadline", { pool: event.pool, window });
        continue;
      }
      const resetsAt = limit.value.resetsAt.value;
      const observedAt = yield* DateTime.now;
      const delay = Duration.toMillis(DateTime.distance(observedAt, resetsAt));
      if (delay <= 0) {
        yield* Effect.logDebug("Pool reset deadline has passed", { pool: event.pool, window });
        continue;
      }
      yield* Effect.logDebug("Scheduled pool reset notification", {
        pool: event.pool,
        window,
        resetsAt,
      });
      yield* FiberMap.run(
        poolResets,
        key,
        Effect.sleep(delay).pipe(
          Effect.andThen(
            Effect.logInfo("Pool reset deadline reached", { pool: event.pool, window }),
          ),
          Effect.andThen(
            bus.publish([
              { audience: InstanceScope.make(), target: { kind: "attention", id: "instance" } },
            ]),
          ),
        ),
      );
    }
  });
  for (const event of yield* latestPoolRateLimits(database)) yield* schedulePoolResets(event);

  return { schedule: schedulePoolResets } as const;
});
