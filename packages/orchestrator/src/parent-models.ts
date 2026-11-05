import { gatewayModelAccess, preflightGatewayModels } from "@usine/durable/gateway";
import type { LoadedInstance } from "@usine/config/instance";
import type { InstanceId } from "@usine/core/instance";
import { RepositoryName } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { GatewayModelError, gatewayModelRouteFor } from "@usine/executor/gateway";
import { Config, Effect, Option } from "effect";

/** Checks the configured coordinator providers before the durable runtime resumes attempts. */
export const parentModels = Effect.fn("Orchestrator.parentModels")(function* (
  startup: LoadedInstance,
  instanceId: InstanceId,
) {
  const configured = startup.config.workers.find(
    (worker) => worker.kind === "ssh" && Option.isSome(worker.gateway),
  );
  if (configured?.kind !== "ssh" || Option.isNone(configured.gateway)) return undefined;
  const gateway = configured.gateway.value;
  const adminToken = yield* Config.Redacted(gateway.adminTokenEnv).pipe(
    Effect.mapError(() =>
      GatewayModelError.make({
        message: `Set ${gateway.adminTokenEnv} to the gateway admin token.`,
      }),
    ),
  );
  const route = yield* gatewayModelRouteFor(
    WorkerName.make(`coordinator-${instanceId}`),
    RepositoryName.make("usine/coordinator"),
    { ...gateway, adminToken },
  );
  const context = yield* Effect.context<never>();
  const access = gatewayModelAccess({
    credential: (protocol, signal) =>
      Effect.runPromiseWith(context)(
        Effect.map(route.credential(protocol), Option.getOrUndefined),
        { signal },
      ),
    request: (protocol, body, headers, signal) =>
      Effect.runPromiseWith(context)(route.request(protocol, body, headers, signal), { signal }),
  });
  const named = [
    ...Option.toArray(startup.config.settings.parentModel),
    ...startup.agents.flatMap(({ parentModel }) => Option.toArray(parentModel)),
  ];
  yield* preflightGatewayModels(access, named).pipe(
    Effect.mapError(({ message }) => GatewayModelError.make({ message })),
  );
  return access;
});
