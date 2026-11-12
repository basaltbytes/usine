import { CredentialRoute } from "@usine/agents/harness";
import { BrainSpec } from "@usine/core/agent/brain";
import { BillingPool, TokenCount, UsdAmount } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { type Brand, Context, Effect, Layer, Option, Schema } from "effect";

import type { AttemptRequest } from "../attempt-runtime.ts";
import {
  type AttemptContext,
  type CoordinatorEvent,
  Decision,
} from "../attempt/coordinator/rules.ts";
import type { EventSequence } from "./journal.ts";

/**
 * What answered an event: the event's rule, a structured completion, or a harness session. Every
 * model call goes through the harness contract, so no handler names a provider or harness.
 */
const DecisionHandler = Schema.Literals(["rule", "completion", "session"]);

/** The cumulative usage of the model call that made a decision. */
export class HandlerUsage extends Schema.Class<
  HandlerUsage,
  Brand.Brand<"@usine/durable/coordinator/wake-up/HandlerUsage">
>("@usine/durable/HandlerUsage")({
  /** Output plus uncached input tokens, excluding cache reads. */
  totalTokens: TokenCount,
  /** The harness-reported price in US dollars, or `None` if the harness doesn't price usage. */
  costUsd: Schema.OptionFromNullOr(UsdAmount),
}) {}

/** The model call that made a decision: its brain, credential route, billing pool, and usage. */
export class HandlerSession extends Schema.Class<
  HandlerSession,
  Brand.Brand<"@usine/durable/coordinator/wake-up/HandlerSession">
>("@usine/durable/HandlerSession")({
  brain: BrainSpec,
  route: CredentialRoute,
  pool: BillingPool,
  usage: HandlerUsage,
}) {}

/**
 * The decision recorded for one event, with the handler that made it. `session` is present exactly
 * when a model handler made the decision.
 */
export class RecordedDecision extends Schema.Class<
  RecordedDecision,
  Brand.Brand<"@usine/durable/coordinator/wake-up/RecordedDecision">
>("@usine/durable/RecordedDecision")(
  Schema.Struct({
    decision: Decision,
    handler: DecisionHandler,
    session: Schema.OptionFromOptionalKey(HandlerSession).pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.none<HandlerSession>())),
    ),
  }).check(
    Schema.makeFilter(
      ({ handler, session }) =>
        (handler === "rule") === Option.isNone(session) ||
        "Expected a handler session for a model's decision and none for a rule's",
    ),
  ),
) {}

/** The Attempt that one wake-up is about, beyond what `AttemptContext` bounds for a prompt. */
export interface WakeUpAttempt {
  readonly attemptId: AttemptId;
  /** The journal sequence of the event being handled. */
  readonly sequence: EventSequence;
  /** The Attempt's stored run spec, with its agent and the agent's brain. */
  readonly spec: AttemptChannel.RunSpec;
  /**
   * Returns the request of the attached `execute` call: the host, worker, machine, working
   * directory, environment, and gateway credential that a session on the Attempt's worker needs.
   */
  readonly request: Effect.Effect<AttemptRequest>;
}

/**
 * Wakes one handler for each lifecycle event of an event-driven Attempt. The coordinator records
 * the handler's decision, then checks it with `clamp`, whatever handled it.
 */
export class WakeUp extends Context.Service<
  WakeUp,
  {
    /**
     * Returns one decision for `event`, or `None` to apply the event's rule. Never fails the
     * Attempt: a handler that can't decide returns `None`. A cancel interrupts the handler, so it
     * must be interruptible and release what it opened in its finalizers.
     */
    readonly handle: (
      event: CoordinatorEvent,
      context: AttemptContext,
      attempt: WakeUpAttempt,
    ) => Effect.Effect<Option.Option<RecordedDecision>>;
  }
>()("@usine/durable/coordinator/wake-up/WakeUp") {
  /** Sends every event to its rule. */
  static readonly rules = Layer.succeed(WakeUp, WakeUp.of({ handle: () => Effect.succeedNone }));
}
