import { SupervisorSandbox, type SupervisorSandboxService } from "@usine/agents/supervisor";
import type { InstanceDirectory, InstanceId } from "@usine/core/instance";
import { SupervisorLimits, WorkerName } from "@usine/core/worker";
import { ATTEMPT_IMAGE } from "@usine/executor/ssh";
import { containerSandboxLayer } from "@usine/executor/supervisor";
import { Context, Duration, Effect, Layer, Option } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";
import { instanceModelRoute } from "./parent-models.ts";

/**
 * Logs a warning, with the reason, when the instance configures a supervisor that `sandbox` can't
 * run sessions for. The orchestrator starts either way.
 */
export const reportSupervisorAvailability = Effect.fn("Supervisor.reportAvailability")(function* (
  configured: boolean,
  sandbox: SupervisorSandboxService,
) {
  if (!configured || Option.isNone(sandbox.unavailable)) return;
  yield* Effect.logWarning("The configured supervisor is unavailable on this orchestrator", {
    reason: sandbox.unavailable.value.message,
  });
});

/**
 * The orchestrator's supervisor sandbox: a container per turn on this host, with the attempt
 * image, whose model requests go through the instance's gateway route. Builds without a container
 * runtime or a gateway, and then logs the reason when the instance configures a supervisor.
 */
export const supervisorSandboxLayer = (
  instanceDirectory: InstanceDirectory,
  instanceId: InstanceId,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const startup = yield* (yield* CurrentInstance).get;
      const route = yield* instanceModelRoute(startup, WorkerName.make(`supervisor-${instanceId}`));
      return containerSandboxLayer({
        root: `${instanceDirectory}/.usine/supervisor`,
        image: ATTEMPT_IMAGE,
        imagePullTimeout: startup.config.settings.supervisorImagePullTimeoutMinutes.pipe(
          Option.map(Duration.minutes),
          Option.getOrUndefined,
        ),
        limits: Option.getOrElse(startup.config.settings.supervisorLimits, () =>
          SupervisorLimits.make({}),
        ),
        runtime: Option.none(),
        route,
      }).pipe(
        Layer.tap((context) =>
          reportSupervisorAvailability(
            Option.isSome(startup.config.settings.supervisor),
            Context.get(context, SupervisorSandbox),
          ),
        ),
      );
    }),
  );
