import { AgentSessionId } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";

/**
 * Returns the session ID that addresses the Attempt's coordinator: the Pi parent, or the
 * event-driven coordinator's stand-in for one. It is the default target of operator input.
 */
export const parentSessionId = (attemptId: AttemptId): AgentSessionId =>
  AgentSessionId.make(`parent:${attemptId}`);

/** Returns the session ID of the Attempt's `count`th child delegation. */
export const childSessionId = (attemptId: AttemptId, count: number): AgentSessionId =>
  AgentSessionId.make(`${parentSessionId(attemptId)}:child:${count}`);

/** Returns the session ID of the model call that decides the Attempt's event `sequence`. */
export const decisionSessionId = (attemptId: AttemptId, sequence: number): AgentSessionId =>
  AgentSessionId.make(`${parentSessionId(attemptId)}:decision:${sequence}`);
