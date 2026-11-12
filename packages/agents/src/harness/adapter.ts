import type { BrainSpec } from "@usine/core/agent/brain";
import {
  type AgentSession,
  type AgentSessionId,
  type BillingPool,
  ChildSession,
  type EndpointName,
  type HarnessSession,
  ParentSession,
  RoleSession,
} from "@usine/core/agent/session";
import type { GatewayCredentialKind } from "@usine/core/worker";
import { Match, Option } from "effect";
import type { CredentialRoute } from "./capability.ts";
import type { Start } from "./contract.ts";

/** The first message of `start`, or `None` when it reopens a saved conversation. */
export const startPrompt = (start: Start): Option.Option<string> =>
  start._tag === "StartPrompt" ? Option.some(start.text) : Option.none();

/** The saved conversation that `start` reopens, or `None` for a new conversation. */
export const startReference = (start: Start): Option.Option<HarnessSession> =>
  start._tag === "StartResume" ? Option.some(start.reference) : Option.none();

/** The brain, billing pool, and endpoint that a harness resolved when the session started. */
export interface ResolvedLaunch {
  readonly brain: BrainSpec;
  readonly pool: Option.Option<BillingPool>;
  readonly endpoint: Option.Option<EndpointName>;
}

/** Returns `session` with what the harness resolved at launch; other fields are kept. */
export const resolvedSession = (session: AgentSession, resolved: ResolvedLaunch): AgentSession =>
  Match.valueTags(session, {
    ParentSession: (parent) => ParentSession.make({ ...parent, ...resolved }),
    ChildSession: (child) => ChildSession.make({ ...child, ...resolved }),
    RoleSession: (role) => RoleSession.make({ ...role, ...resolved }),
  });

/** The session that `session` acts for, or `None` for a parent or a role session without one. */
const parentOf = (session: AgentSession): Option.Option<AgentSessionId> =>
  Match.valueTags(session, {
    ParentSession: () => Option.none(),
    ChildSession: (child) => Option.some(child.parentId),
    RoleSession: (role) => role.parentId,
  });

/** Log fields naming the parent of `session`, if it has one. */
export const parentFields = (
  session: AgentSession,
): { readonly parentSessionId?: AgentSessionId } =>
  Option.match(parentOf(session), {
    onNone: () => ({}),
    onSome: (parentSessionId) => ({ parentSessionId }),
  });

/**
 * The credential kind that a gateway reported for `route`, or `None` for a route without one,
 * including a gateway route whose kind isn't reported yet.
 */
export const gatewayCredential = (route: CredentialRoute): Option.Option<GatewayCredentialKind> =>
  route === "gateway-api-key"
    ? Option.some("api-key")
    : route === "gateway-subscription"
      ? Option.some("subscription")
      : Option.none();
