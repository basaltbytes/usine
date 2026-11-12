import { BrainSpec, Harness } from "@usine/core/agent/brain";
import {
  HarnessReadiness,
  HarnessReady,
  HarnessUnavailableError,
} from "@usine/core/agent/capability";
import type { Scope } from "effect";
import type { AgentSessionError } from "../runtime.ts";
import { MachineId, WorkerName } from "@usine/core/worker";
import { type Brand, Effect, Option, Schema } from "effect";
import { admitBrain, AdmissionContext } from "./admission.ts";
import { codingAgent } from "./launch.ts";
import type { HarnessCatalog } from "./harness.ts";
import { CredentialRoute, Placement } from "./capability.ts";
import { ChildHost } from "../child-host/child-host.ts";
import { SessionOperationError } from "../runtime.ts";
import type { ContinuationPolicy } from "./continuation.ts";
import type { NativeSession, SessionSpec, Start } from "./contract.ts";
import { type HostToolServices, type HostToolSet, hostToolSet, noHostTools } from "./tools.ts";
import type { Tool, Toolkit } from "effect/ai";

/** Where and how to check a brain without starting a prompt. */
export class ProbeTarget extends Schema.Class<
  ProbeTarget,
  Brand.Brand<"@usine/agents/harness/runtime/ProbeTarget">
>("@usine/agents/ProbeTarget")({
  host: ChildHost,
  environment: Schema.Record(Schema.String, Schema.String),
  /** Where `host` runs sessions; a sandbox shell is `sandbox`, not `ssh`. */
  placement: Placement,
  /** The route that supplies the model credential, as admission names it. */
  credential: CredentialRoute,
  worker: WorkerName,
  machine: Schema.Option(MachineId),
}) {}

/**
 * One harness behind a role-neutral seam: a preflight without a prompt, and native sessions opened
 * from a `SessionSpec`. Roles add their policy on top, as `childContinuation` does for children.
 */
export interface HarnessRuntime {
  readonly id: Harness;
  /**
   * Opens the native session that `spec` describes in the calling scope, starting with a prompt
   * or reopening a saved conversation. `continuation` supplies the restored conversation state and
   * the recovery decisions after a lost transport. The session can call the tools of `tools`, with
   * the handlers of the calling context, so the role that opens it scopes what they reach; when
   * the role closes native tools, they are the only tools that the session lists.
   */
  readonly open: <Tools extends Record<string, Tool.Any> = Record<never, never>>(
    spec: SessionSpec,
    start: Start,
    continuation: ContinuationPolicy,
    tools?: Toolkit.Toolkit<Tools>,
  ) => Effect.Effect<NativeSession, AgentSessionError, Scope.Scope | HostToolServices<Tools>>;
  /** Stops a retained native process of `spec` without reopening its conversation. */
  readonly stop: (spec: SessionSpec) => Effect.Effect<void, AgentSessionError>;
  readonly preflight: (
    brain: BrainSpec,
    target: ProbeTarget,
  ) => Effect.Effect<HarnessReadiness, SessionOperationError>;
}

/** Opens a native session that serves `tools`, already bound to the opening role's handlers. */
export type OpenSession = (
  spec: SessionSpec,
  start: Start,
  continuation: ContinuationPolicy,
  tools: HostToolSet,
) => Effect.Effect<NativeSession, AgentSessionError, Scope.Scope>;

/** Returns `HarnessRuntime.open` over an adapter's `open`, binding the toolkit to its handlers. */
export const openWithTools =
  (open: OpenSession): HarnessRuntime["open"] =>
  (spec, start, continuation, tools) =>
    tools === undefined
      ? open(spec, start, continuation, noHostTools)
      : Effect.flatMap(hostToolSet(tools), (bound) => open(spec, start, continuation, bound));

export const loginUnavailable = (brain: BrainSpec, message: string) =>
  HarnessUnavailableError.make({ harness: brain.harness, capability: "login", message });

/** Checks a worker's coding-agent brain against the dispatched runtime's catalog. */
export const admitPreflight = Effect.fn("HarnessAdmission.preflight")(function* (
  catalog: HarnessCatalog,
  brain: BrainSpec,
  target: ProbeTarget,
) {
  yield* Effect.annotateCurrentSpan({
    harness: brain.harness,
    model: brain.model,
    worker: target.worker,
  });
  return yield* Effect.fromResult(
    admitBrain(
      catalog,
      codingAgent,
      brain,
      AdmissionContext.make({ placement: target.placement, credential: target.credential }),
    ),
  ).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Worker brain refused", {
        role: error.role,
        harness: error.harness,
        missing: error.missing,
        worker: target.worker,
      }),
    ),
    Effect.mapError((error) =>
      HarnessUnavailableError.make({
        harness: error.harness,
        capability: "binary",
        message: error.message,
      }),
    ),
  );
});

/** Applies the shared preflight deadline and reports capability gaps without retrying them. */
export const checkedPreflight = <R>(
  check: (
    brain: BrainSpec,
    target: ProbeTarget,
  ) => Effect.Effect<void, HarnessUnavailableError | SessionOperationError, R>,
) =>
  Effect.fn("HarnessRuntime.preflight")(
    function* (brain: BrainSpec, target: ProbeTarget) {
      yield* Effect.annotateCurrentSpan({
        harness: brain.harness,
        model: brain.model,
        worker: target.worker,
        host: target.host._tag,
        placement: target.placement,
        credential: target.credential,
        ...Option.match(target.machine, { onNone: () => ({}), onSome: (machine) => ({ machine }) }),
      });
      yield* check(brain, target);
      yield* Effect.logInfo("Worker harness verified", {
        harness: brain.harness,
        model: brain.model,
        worker: target.worker,
        credential: target.credential,
      });
      return HarnessReady.make({ harness: brain.harness });
    },
    (effect, brain) =>
      effect.pipe(
        Effect.timeout("60 seconds"),
        Effect.catchTag("TimeoutError", (cause) =>
          SessionOperationError.make({
            operation: "launch",
            sessionId: Option.none(),
            message: `${brain.harness} readiness check timed out`,
            cause,
          }),
        ),
        Effect.tapError((error) =>
          Effect.logError("Worker harness preflight failed", {
            harness: brain.harness,
            model: brain.model,
            errorTag: error._tag,
            message: error.message,
          }),
        ),
        Effect.catchTag("HarnessUnavailableError", (unavailable) => Effect.succeed(unavailable)),
      ),
  );
