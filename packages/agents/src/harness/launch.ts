import type { ChildHost } from "../child-host/child-host.ts";
import { AgentResultError, type ChildRequest } from "../runtime.ts";
import { Effect, Option } from "effect";
import { admitBrain, AdmissionContext } from "./admission.ts";
import { catalog } from "./catalog.ts";
import type { Placement } from "./capability.ts";

export const hostPlacement = (host: ChildHost): Placement =>
  host._tag === "LocalProcess" ? "local" : host.container === undefined ? "ssh" : "container";

/** Reads credential metadata without retaining credential values. */
export const childAdmissionContext = (request: ChildRequest): AdmissionContext => {
  const credential = request.session.gatewayCredential;
  const provider = Option.flatMap(
    catalog.get(request.session.brain.harness),
    (descriptor) => descriptor.worker.credential,
  );
  return AdmissionContext.make({
    placement: hostPlacement(request.host),
    credential: Option.isSome(credential)
      ? credential.value === "subscription"
        ? "gateway-subscription"
        : "gateway-api-key"
      : Option.isSome(provider) &&
          request.environment[`${provider.value.provider.toUpperCase()}_API_KEY`] !== undefined
        ? "api-key"
        : "host-login",
  });
};

export const admitChild = Effect.fn("HarnessAdmission.child")(function* (request: ChildRequest) {
  yield* Effect.annotateCurrentSpan({
    sessionId: request.session.id,
    worker: request.worker,
    harness: request.session.brain.harness,
  });
  return yield* Effect.fromResult(
    admitBrain(catalog, "coding-agent", request.session.brain, childAdmissionContext(request)),
  ).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Child brain refused", {
        role: error.role,
        harness: error.harness,
        missing: error.missing,
        worker: request.worker,
      }),
    ),
    Effect.mapError((error) =>
      AgentResultError.make({ sessionId: Option.some(request.session.id), message: error.message }),
    ),
  );
});
