import type { Harness } from "@usine/core/agent/brain";
import { RoleName } from "@usine/core/agent/session";
import type { GatewayCredentialKind } from "@usine/core/worker";
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
  nativeTools: "all",
  hostTools: false,
  persistence: "saved",
  interventions: true,
  output: "text",
});

export const hostPlacement = (host: ChildHost): Placement =>
  host._tag === "LocalProcess" ? "local" : host.container === undefined ? "ssh" : "container";

/** What `workerAdmissionContext` reads of a session that runs on a worker. */
export interface WorkerSession {
  readonly harness: Harness;
  readonly host: ChildHost;
  /** The environment of the harness process. */
  readonly environment: Readonly<Record<string, string>>;
  /** The credential kind that the worker's gateway injects, or `None` without one. */
  readonly gatewayCredential: Option.Option<GatewayCredentialKind>;
}

/**
 * Returns the placement and credential route of a session of any role on a worker: the gateway's
 * credential kind, else the harness's API key when `environment` sets it, else the host's login.
 * Reads credential metadata without retaining credential values.
 */
export const workerAdmissionContext = (
  catalog: HarnessCatalog,
  session: WorkerSession,
): AdmissionContext => {
  const credential = session.gatewayCredential;
  const provider = Option.flatMap(
    catalog.get(session.harness),
    (descriptor) => descriptor.worker.credential,
  );
  return AdmissionContext.make({
    placement: hostPlacement(session.host),
    credential: Option.isSome(credential)
      ? credential.value === "subscription"
        ? "gateway-subscription"
        : "gateway-api-key"
      : Option.isSome(provider) &&
          session.environment[provider.value.apiKey.tokenVariable] !== undefined
        ? "api-key"
        : "host-login",
  });
};

/** Reads credential metadata without retaining credential values. */
export const childAdmissionContext = (
  catalog: HarnessCatalog,
  request: ChildRequest,
): AdmissionContext =>
  workerAdmissionContext(catalog, {
    harness: request.session.brain.harness,
    host: request.host,
    environment: request.environment,
    gatewayCredential: request.session.gatewayCredential,
  });

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
 * opens. A `StartResume` also requires `resume-session`. An opened session always saves its
 * conversation and returns text, so a role that keeps no conversation or returns a structured value
 * is refused. Only a role that does both runs as a completion; any other such role has no primitive
 * until a session can run without saving its conversation. `hostTools` states whether the session
 * opens with a usine tool set, which it must exactly when its role runs one.
 */
export const admitSession = Effect.fn("HarnessAdmission.session")(function* (
  catalog: HarnessCatalog,
  spec: SessionSpec,
  start: Start,
  hostTools: boolean,
) {
  const resume = start._tag === "StartResume";
  const { role, context } = spec.admitted;
  yield* Effect.annotateCurrentSpan({
    sessionId: spec.session.id,
    role: role.name,
    worker: spec.worker,
    harness: spec.session.brain.harness,
  });
  const refuse = (message: string) =>
    Effect.logWarning("Harness session refused", {
      sessionId: spec.session.id,
      role: role.name,
      harness: spec.session.brain.harness,
      message,
    }).pipe(
      Effect.andThen(
        Effect.fail(AgentResultError.make({ sessionId: Option.some(spec.session.id), message })),
      ),
    );
  if (role.persistence === "ephemeral" || role.output === "structured")
    return yield* refuse(
      `${role.name} keeps no conversation or returns a structured value, but a session always saves its conversation and returns text; only a role that returns a structured value and keeps no conversation runs as a completion`,
    );
  if (role.hostTools !== hostTools)
    return yield* refuse(
      role.hostTools
        ? `The ${role.name} role runs a usine tool set, but its session opened without one`
        : `The ${role.name} role runs no usine tool set, but its session opened with one`,
    );
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
      "idleAnsweredOperator",
    ]),
  );
