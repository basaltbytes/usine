import type { SupervisorSandboxService } from "@usine/agents/supervisor";
import { Effect, Option } from "effect";

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
