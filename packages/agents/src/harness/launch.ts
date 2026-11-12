import { RoleName } from "@usine/core/agent/session";
import type { ChildHost } from "../child-host/child-host.ts";
import { AgentResultError, type ChildRequest, RestartState } from "../runtime.ts";
import { Effect, Option, Struct } from "effect";
import { admitBrain, AdmissionContext, AdmittedBrain, routePool } from "./admission.ts";
import { SessionSpec, type Start } from "./contract.ts";
import type { HarnessCatalog } from "./harness.ts";
import type { Placement } from "./capability.ts";
import { RolePlacements, RoleSpec } from "./role.ts";

/**
 * The coding agent: a child that works in a worker checkout with the harness's own tools, keeps
 * its conversation, and takes steering, interrupts, and operator messages.
 */
export const codingAgent = RoleSpec.make({
  name: RoleName.make("coding-agent"),
  placement: RolePlacements.make({
    placements: ["local", "ssh", "container", "sandbox"],
    reason: "The coding agent runs on a worker",
  }),
  credential: Option.none(),
  nativeTools: true,
  hostTools: false,
  persistence: "saved",
  interventions: true,
  output: "text",
});

export const hostPlacement = (host: ChildHost): Placement =>
  host._tag === "LocalProcess" ? "local" : host.container === undefined ? "ssh" : "container";

/** Reads credential metadata without retaining credential values. */
export const childAdmissionContext = (
  catalog: HarnessCatalog,
  request: ChildRequest,
): AdmissionContext => {
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
          request.environment[provider.value.apiKey.tokenVariable] !== undefined
        ? "api-key"
        : "host-login",
  });
};

export const admitChild = Effect.fn("HarnessAdmission.child")(function* (
  catalog: HarnessCatalog,
  request: ChildRequest,
) {
  yield* Effect.annotateCurrentSpan({
    sessionId: request.session.id,
    worker: request.worker,
    harness: request.session.brain.harness,
  });
  const context = childAdmissionContext(catalog, request);
  return yield* Effect.fromResult(
    admitBrain(catalog, codingAgent, request.session.brain, context, {
      reopens: Option.isSome(request.resume),
    }),
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("Child credential route admitted", {
        sessionId: request.session.id,
        harness: request.session.brain.harness,
        credentialRoute: context.credential,
        placement: context.placement,
        resume: Option.isSome(request.resume),
      }),
    ),
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

/**
 * Admits the brain of `spec` for its role at its placement and credential route before a session
 * opens. A `StartResume` also requires `resume-session`.
 */
export const admitSession = Effect.fn("HarnessAdmission.session")(function* (
  catalog: HarnessCatalog,
  spec: SessionSpec,
  start: Start,
) {
  const resume = start._tag === "StartResume";
  const { role, context } = spec.admitted;
  yield* Effect.annotateCurrentSpan({
    sessionId: spec.session.id,
    role: role.name,
    worker: spec.worker,
    harness: spec.session.brain.harness,
  });
  return yield* Effect.fromResult(
    admitBrain(catalog, role, spec.session.brain, context, { reopens: resume }),
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("Harness session admitted", {
        sessionId: spec.session.id,
        role: role.name,
        harness: spec.session.brain.harness,
        credentialRoute: context.credential,
        placement: context.placement,
        resume,
      }),
    ),
    Effect.tapError((error) =>
      Effect.logWarning("Harness session refused", {
        sessionId: spec.session.id,
        role: error.role,
        harness: error.harness,
        missing: error.missing,
        worker: spec.worker,
      }),
    ),
    Effect.mapError((error) =>
      AgentResultError.make({ sessionId: Option.some(spec.session.id), message: error.message }),
    ),
  );
});

/**
 * The coding-agent route of `request` without checking it, for an operation such as stopping a
 * retained process that opens no session.
 */
export const childRoute = (catalog: HarnessCatalog, request: ChildRequest): AdmittedBrain => {
  const context = childAdmissionContext(catalog, request);
  return AdmittedBrain.make({
    role: codingAgent,
    brain: request.session.brain,
    context,
    pool: Option.flatMap(catalog.get(request.session.brain.harness), (descriptor) =>
      routePool(descriptor, context.credential),
    ),
  });
};

/** Builds the session spec of `request` for the brain that admission resolved. */
export const childSpec = (request: ChildRequest, admitted: AdmittedBrain): SessionSpec =>
  SessionSpec.make({
    session: request.session,
    admitted,
    host: request.host,
    worker: request.worker,
    machine: request.machine,
    cwd: request.cwd,
    environment: request.environment,
  });

/** The conversation state that `request` restores. */
export const childRestart = (request: ChildRequest): RestartState =>
  RestartState.make(
    Struct.pick(request, [
      "prompted",
      "continuations",
      "inFlight",
      "unread",
      "usage",
      "held",
      "paused",
      "idle",
    ]),
  );
