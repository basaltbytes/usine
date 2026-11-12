import type { RunningSession } from "@usine/agents/runtime";
import type { AgentSessionId } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure } from "@usine/core/attempt/failure";
import {
  type Brand,
  Deferred,
  Effect,
  FiberSet,
  Option,
  Result,
  Schema,
  Scope,
  Semaphore,
} from "effect";

import type { ChildDelivery } from "../attempt/delegation/journal.ts";
import {
  type AttemptJournal,
  EncodedIntervention,
  type JournalError,
  QueuedInput,
  Supervision,
} from "./journal.ts";
import type { Outbox } from "./outbox.ts";
import type { Supervisor } from "./supervision.ts";

/**
 * An operator input that the coordinator couldn't apply. The reason is recorded in the transcript,
 * and the Attempt continues.
 */
class InterventionRefused extends Schema.TaggedError<
  InterventionRefused,
  Brand.Brand<"@usine/durable/coordinator/interventions/InterventionRefused">
>("@usine/durable/coordinator/InterventionRefused")("InterventionRefused", {
  message: Schema.NonEmptyString,
}) {}

const refuse = (message: string) => InterventionRefused.make({ message });

/** The second receipt's reason when a child stops before it reads a queued operator input. */
const UNREAD_INPUT =
  "The child stopped before it read this message. Send it again if it still applies.";

const InterventionJson = Schema.toCodecJson(AttemptChannel.Intervention);
const encodeIntervention = Schema.encodeEffect(InterventionJson);
const decodeIntervention = Schema.decodeUnknownEffect(InterventionJson);

/** The in-process state of one coordinated Attempt that operator input reads and changes. */
export interface InterventionTarget {
  readonly attemptId: AttemptId;
  readonly outbox: Outbox;
  /** The live children by session ID. */
  readonly children: Map<AgentSessionId, RunningSession>;
  /** The sequence numbers of operator inputs that live children queued and haven't reported. */
  readonly childInputs: Set<number>;
  readonly supervisor: Supervisor;
}

/** Operator input to one Attempt that the event-driven coordinator runs (ADR 0018). */
export interface Interventions {
  /**
   * Serializes operator input and its receipts. The coordinator commits its transitions under it,
   * so no receipt precedes `Started` or follows the terminal envelope.
   */
  readonly routing: Semaphore.Semaphore;
  /**
   * Records the input in the transcript, applies it to its target child, or to the live child for
   * input addressed to the parent, and records the receipt. Fails with `AgentFailure` before
   * `Started`, after the terminal envelope, or while no `execute` call is attached.
   */
  readonly intervene: (
    intervention: AttemptChannel.Intervention,
  ) => Effect.Effect<void, AttemptFailure | JournalError>;
  /** Receives a child's report that it read a queued input, or stopped before it did. */
  readonly delivery: (delivery: ChildDelivery) => Effect.Effect<void>;
  /**
   * Signals that a child became live, a delegation ended, or the `execute` call detached, so input
   * addressed to the parent that waits for the open delegation's child checks again.
   */
  readonly childChanged: Effect.Effect<void>;
  /**
   * Sends the receipts that ended children owe: it waits for the receipts of read inputs, then
   * rejects the stored inputs of children that are no longer live. Run it after a child ends and
   * before the event that its end produces, so every receipt precedes that event's envelopes.
   */
  readonly settle: Effect.Effect<void, AttemptFailure | JournalError>;
}

/**
 * Returns the operator input of `target`. Receipts for read inputs run in fibers of `scope`, because
 * a child can report a read while `intervene` holds the routing permit.
 */
export const interventionsFor = Effect.fn("Interventions.make")(function* (
  journal: AttemptJournal["Service"],
  target: InterventionTarget,
  scope: Scope.Scope,
) {
  const { attemptId, outbox, children, childInputs, supervisor } = target;
  const routing = yield* Semaphore.make(1);
  const deliveries = yield* FiberSet.make<void, never>().pipe(Scope.provide(scope));
  // Replaced after each change; a waiter reads it before it checks, so it misses no change.
  let changed = yield* Deferred.make<void>();
  const childChanged = Effect.gen(function* () {
    const previous = changed;
    changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
  });

  const snapshot = journal.load(attemptId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error(`Attempt ${attemptId} has no journal`)),
        onSome: Effect.succeed,
      }),
    ),
  );

  /**
   * Sends the stored input's second receipt and forgets the input in the same journal write, so a
   * stop can't send the receipt twice or keep an input it settled. The caller holds the permit.
   */
  const receipt = (
    inputSequence: AttemptChannel.Sequence,
    intervention: AttemptChannel.Intervention,
    delivered: Option.Option<AttemptChannel.InterventionState>,
  ) =>
    outbox.commit(
      [
        Option.match(delivered, {
          onSome: (state): AttemptChannel.OutboundPayload =>
            AttemptChannel.InterventionApplied.make({ inputSequence, intervention, state }),
          onNone: () =>
            AttemptChannel.InterventionRejected.make({
              inputSequence,
              intervention,
              message: UNREAD_INPUT,
            }),
        }),
      ],
      (outbound) => journal.forgetInput(attemptId, inputSequence, outbound),
    );

  /**
   * Sends the second receipt for an input that a child queued and then read, unless it was already
   * sent. While no `execute` call is attached, the input stays stored for the child that resumes
   * it. The caller holds the permit.
   */
  const delivered = Effect.fn("Interventions.delivered")(
    function* (delivery: ChildDelivery) {
      const { inputSequence, intervention } = delivery;
      const fields = { attemptId, inputSequence, action: intervention.action._tag };
      yield* Effect.annotateCurrentSpan(fields);
      childInputs.delete(inputSequence);
      const stored = yield* snapshot;
      if (!stored.inputs.some((input) => input.inputSequence === inputSequence))
        return yield* Effect.logInfo(
          "A child reported an operator input already settled; it gets no second receipt",
          fields,
        );
      if (!(yield* outbox.attached))
        return yield* Effect.logInfo(
          "No execute call relays the Attempt; the read operator input stays stored for the resumed child",
          fields,
        );
      yield* receipt(inputSequence, intervention, delivery.delivered);
      yield* Effect.logInfo("The child read a queued operator input", fields);
    },
    (effect, delivery) =>
      effect.pipe(
        Effect.catch((failure) =>
          Effect.logError("Could not send the second receipt of an operator input", {
            attemptId,
            inputSequence: delivery.inputSequence,
            errorTag: failure._tag,
            message: failure.message,
          }),
        ),
      ),
  );

  // An input that the child didn't read stays stored: the resumed child reads it after a process
  // stop, and `settle` rejects it once the child's delegation ends.
  const delivery = (report: ChildDelivery) =>
    Option.isSome(report.delivered)
      ? FiberSet.run(deliveries, routing.withPermits(1)(delivered(report))).pipe(Effect.asVoid)
      : Effect.sync(() => childInputs.delete(report.inputSequence)).pipe(
          Effect.andThen(
            Effect.logInfo(
              "The child stopped before it read a queued operator input; the input stays stored",
              { attemptId, inputSequence: report.inputSequence },
            ),
          ),
        );

  /** Rejects the stored inputs of children that are no longer live. The caller holds the permit. */
  const rejectUnread = Effect.fn("Interventions.rejectUnread")(function* () {
    for (const input of (yield* snapshot).inputs) {
      if (children.has(input.sessionId)) continue;
      const fields = {
        attemptId,
        inputSequence: input.inputSequence,
        sessionId: input.sessionId,
      };
      const decoded = yield* decodeIntervention(input.intervention).pipe(Effect.result);
      if (Result.isFailure(decoded)) {
        yield* Effect.logWarning(
          "Forgot a queued operator input that no longer decodes; it gets no second receipt",
          fields,
        );
        yield* journal.forgetInput(attemptId, input.inputSequence, []);
        continue;
      }
      childInputs.delete(input.inputSequence);
      yield* receipt(input.inputSequence, decoded.success, Option.none());
      yield* Effect.logWarning(
        "The child ended before it read a queued operator input; the input is rejected",
        fields,
      );
    }
  });

  /** Applies the input to its child and stores the child's supervision and queued input. */
  const route = Effect.fn("Interventions.route")(function* (
    intervention: AttemptChannel.Intervention,
    inputSequence: AttemptChannel.Sequence,
  ) {
    const addressed = intervention.target;
    const live = [...children.values()];
    const [only] = live;
    const child =
      addressed._tag === "Child"
        ? Option.fromUndefinedOr(children.get(addressed.sessionId))
        : Option.fromUndefinedOr(live.length === 1 ? only : undefined);
    if (Option.isNone(child))
      return yield* refuse(
        addressed._tag === "Child"
          ? "This session is no longer live"
          : live.length === 0
            ? "This attempt has no live child session to receive the input"
            : "This attempt has several live child sessions; address one of them",
      );
    const sessionId = child.value.session.id;
    yield* Effect.annotateCurrentSpan({ attemptId, sessionId, inputSequence });
    const forwardedTo = addressed._tag === "Parent" ? Option.some(sessionId) : Option.none();
    const state = yield* child.value
      .intervene(intervention.action, (read) =>
        delivery({
          _tag: "Delivery",
          inputSequence,
          intervention,
          delivered: Option.map(read, (when) =>
            AttemptChannel.InterventionState.make({ ...when, forwardedTo }),
          ),
        }),
      )
      .pipe(
        Effect.mapBoth({
          onFailure: (error) => refuse(error.message),
          onSuccess: (applied) =>
            AttemptChannel.InterventionState.make({ ...applied, forwardedTo }),
        }),
      );
    yield* supervisor.supervise(
      Supervision.make({ sessionId, held: state.held, paused: state.paused }),
    );
    if (state.queued) {
      childInputs.add(inputSequence);
      const encoded = yield* encodeIntervention(intervention).pipe(Effect.orDie);
      yield* journal.queueInput(
        attemptId,
        QueuedInput.make({
          inputSequence,
          sessionId,
          intervention: EncodedIntervention.make(encoded),
        }),
      );
      yield* Effect.logInfo("The working child reads the operator input at its next boundary", {
        sessionId,
        action: intervention.action._tag,
      });
    }
    return state;
  });

  /**
   * Waits while the open delegation's child is starting, as after a reattachment, so that input
   * addressed to the parent reaches the child instead of a rejection. Returns once a child is live,
   * no delegation is open, or no `execute` call is attached.
   */
  const awaitChild = Effect.fn("Interventions.awaitChild")(function* (
    intervention: AttemptChannel.Intervention,
  ) {
    let logged = false;
    while (true) {
      const next = changed;
      if (children.size > 0 || !(yield* outbox.attached)) return;
      const stored = yield* snapshot;
      const starting =
        stored.status._tag === "Open" &&
        stored.delegations.some(({ outcome }) => Option.isNone(outcome));
      if (!starting) return;
      if (!logged) {
        logged = true;
        yield* Effect.logInfo("Input addressed to the parent waits for the child to start", {
          attemptId,
          action: intervention.action._tag,
        });
      }
      yield* Deferred.await(next);
    }
  });

  const intervene = Effect.fn("Interventions.intervene")(function* (
    intervention: AttemptChannel.Intervention,
  ) {
    yield* Effect.annotateCurrentSpan({
      attemptId,
      target: intervention.target._tag,
      action: intervention.action._tag,
    });
    if (intervention.target._tag === "Parent") yield* awaitChild(intervention);
    yield* routing.withPermits(1)(
      Effect.gen(function* () {
        const relaying =
          (yield* outbox.attached) && (yield* outbox.started) && !(yield* outbox.ended);
        if (!relaying) {
          yield* Effect.logWarning("Operator input addressed an Attempt with no live channel", {
            action: intervention.action._tag,
          });
          return yield* AgentFailure.make({ message: "This attempt has no live channel" });
        }
        const inputSequence = yield* outbox.inbound(intervention);
        const applied = yield* route(intervention, inputSequence).pipe(
          Effect.catchTag("JournalError", (error) => Effect.fail(refuse(error.message))),
          Effect.result,
        );
        if (Result.isFailure(applied)) {
          yield* Effect.logWarning("The coordinator refused operator input", {
            action: intervention.action._tag,
            target: intervention.target._tag,
            message: applied.failure.message,
          });
          return yield* outbox.emit([
            AttemptChannel.InterventionRejected.make({
              inputSequence,
              intervention,
              message: applied.failure.message,
            }),
          ]);
        }
        yield* outbox.emit([
          AttemptChannel.InterventionApplied.make({
            inputSequence,
            intervention,
            state: applied.success,
          }),
        ]);
        yield* Effect.logInfo("Operator input applied", {
          action: intervention.action._tag,
          target: intervention.target._tag,
          held: applied.success.held,
          paused: applied.success.paused,
          queued: applied.success.queued,
          forwardedTo: Option.getOrUndefined(applied.success.forwardedTo),
        });
      }),
    );
  });

  return {
    routing,
    intervene,
    delivery,
    childChanged,
    settle: FiberSet.awaitEmpty(deliveries).pipe(
      Effect.andThen(routing.withPermits(1)(rejectUnread())),
    ),
  } satisfies Interventions;
});
