import { gatewayModelAccess, ParentCredentialError } from "@usine/durable/gateway";
import type { LoadedInstance } from "@usine/config/instance";
import type { InstanceId } from "@usine/core/instance";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import {
  GatewayModelError,
  type GatewayModelRoute,
  gatewayModelRouteFor,
} from "@usine/executor/gateway";
import { Config, Effect, Layer, Option, ScopedRef } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { sshHttpClientLayer } from "./http-client.ts";

/**
 * Returns the instance's model route through the gateway of its first SSH Worker that has one,
 * attached as `worker`, or `None` when no Worker has a gateway. The route opens on first use, and
 * a failure to open it is retried after five seconds.
 */
export const instanceModelRoute = Effect.fn("Orchestrator.instanceModelRoute")(function* (
  startup: LoadedInstance,
  worker: WorkerName,
) {
  const configured = startup.config.workers.find(
    (candidate) => candidate.kind === "ssh" && Option.isSome(candidate.gateway),
  );
  if (configured?.kind !== "ssh" || Option.isNone(configured.gateway))
    return Option.none<Effect.Effect<GatewayModelRoute, GatewayModelError>>();
  const gateway = configured.gateway.value;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const route = yield* ScopedRef.make(() => Option.none<GatewayModelRoute>());
  const open = Effect.gen(function* () {
    const adminToken = yield* Config.Redacted(gateway.adminTokenEnv).pipe(
      Effect.mapError(() =>
        GatewayModelError.make({
          message: `Set ${gateway.adminTokenEnv} to the gateway admin token.`,
        }),
      ),
    );
    const http = yield* Layer.build(sshHttpClientLayer);
    return yield* gatewayModelRouteFor(worker, RepositoryName.make("usine/coordinator"), {
      ...gateway,
      adminToken,
    }).pipe(Effect.provideContext(http), Effect.asSome);
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const [current] = yield* Effect.gen(function* () {
    const existing = yield* ScopedRef.get(route);
    if (Option.isSome(existing)) return existing.value;
    yield* ScopedRef.set(route, open);
    const opened = yield* ScopedRef.get(route);
    return yield* Effect.fromOption(opened, () =>
      GatewayModelError.make({
        message: "The orchestrator gateway route closed while opening.",
      }),
    );
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Orchestrator gateway model route unavailable; will retry", {
        worker,
        gateway: gateway.destination,
        message: error.message,
      }),
    ),
    Effect.cachedInvalidateWithTTL("5 seconds"),
  );
  return Option.some(current);
});

/** Provides retryable gateway model access for coordinator admission and launch. */
export const parentModels = Effect.fn("Orchestrator.parentModels")(function* (
  startup: LoadedInstance,
  instanceId: InstanceId,
) {
  const route = yield* instanceModelRoute(startup, WorkerName.make(`coordinator-${instanceId}`));
  if (Option.isNone(route)) return undefined;
  const current = route.value;
  return yield* gatewayModelAccess({
    credential: (protocol) =>
      Effect.flatMap(current, (opened) => opened.credential(protocol)).pipe(
        Effect.mapError((error) => ParentCredentialError.make({ message: error.message })),
      ),
    request: (protocol, body, headers, signal) =>
      Effect.flatMap(current, (opened) => opened.request(protocol, body, headers, signal)).pipe(
        Effect.mapError((error) => ParentCredentialError.make({ message: error.message })),
      ),
  });
});
