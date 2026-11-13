import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, type AttemptFailure } from "@usine/core/attempt/failure";
import { DateTime, Deferred, Effect, Option, type Scope, Semaphore } from "effect";

import { keepNotice } from "../attempt/notices.ts";
import type { JournalError } from "../attempt/journal-error.ts";
import type { AttemptJournal, CoordinatorSnapshot } from "./journal.ts";

/** The sink of the `execute` call relaying the Attempt, with the envelopes it hasn't confirmed. */
interface Channel {
  readonly io: AttemptChannel.Sink;
  /** Reserved envelopes that the sink hasn't confirmed, in sequence order. */
  pending: Array<AttemptChannel.OutboundEnvelope>;
  /** The sequence of the next envelope to reserve. */
  next: AttemptChannel.Sequence;
  /** The sequence of the next operator input. */
  inbound: AttemptChannel.Sequence;
  /** Completes with the first failure to relay activity that has no caller to fail. */
  readonly failed: Deferred.Deferred<never, AttemptFailure | JournalError>;
}

/** The result of `Outbox.notice`. */
type NoticeRouting =
  | { readonly _tag: "Relayed" }
  | { readonly _tag: "Kept"; readonly kept: ReadonlyArray<AttemptChannel.WorkerNotice> }
  | { readonly _tag: "Dropped" };

/**
 * Relays one Attempt's outbound envelopes through the attempt journal's outbox: each batch is
 * reserved in the journal, appended to the attached sink, then acknowledged. A sink that fails
 * leaves the batch reserved, and the next `attach` sends it again; the engine keeps the first copy
 * of an envelope. Operator input is appended to the same sink in its inbound direction.
 */
export interface Outbox {
  /**
   * Attaches `io` until the scope closes and delivers the snapshot's reserved envelopes. Returns
   * false without attaching if another call is attached.
   */
  readonly attach: (
    io: AttemptChannel.Sink,
    snapshot: CoordinatorSnapshot,
  ) => Effect.Effect<boolean, AttemptFailure | JournalError, Scope.Scope>;
  /** Whether an `execute` call is attached. */
  readonly attached: Effect.Effect<boolean>;
  /** Completes with the first failure of `relay`. Never completes while detached. */
  readonly failed: Effect.Effect<AttemptFailure | JournalError>;
  /**
   * Reserves and delivers `payloads` after every envelope reserved so far. Fails with
   * `AgentFailure` while detached or after the terminal envelope.
   */
  readonly emit: (
    payloads: ReadonlyArray<AttemptChannel.OutboundPayload>,
  ) => Effect.Effect<void, AttemptFailure | JournalError>;
  /** Like `emit`, but reports a failure through `failed`, for activity that has no caller to fail. */
  readonly relay: (payloads: ReadonlyArray<AttemptChannel.OutboundPayload>) => Effect.Effect<void>;
  /**
   * Records the next operator input's sequence in the journal, appends the input to the attached
   * sink's transcript, and returns the sequence. Fails with `AgentFailure` while detached.
   */
  readonly inbound: (
    intervention: AttemptChannel.Intervention,
  ) => Effect.Effect<AttemptChannel.Sequence, AttemptFailure | JournalError>;
  /**
   * Builds envelopes for `payloads`, commits them with `write`, which must reserve exactly those
   * envelopes, then delivers them. With `terminal`, the last payload ends the channel.
   */
  readonly commit: <A, E>(
    payloads: ReadonlyArray<AttemptChannel.OutboundPayload>,
    write: (outbound: ReadonlyArray<AttemptChannel.OutboundEnvelope>) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | AttemptFailure | JournalError>;
  /**
   * Relays a Worker notice after `Started`. Before it, or while no call is attached, keeps the
   * latest notice and a preceding `WorkerUnresponsive`. After the terminal envelope, drops it.
   */
  readonly notice: (notice: AttemptChannel.WorkerNotice) => Effect.Effect<NoticeRouting>;
  /** Returns the kept notices and forgets them. */
  readonly takeKept: Effect.Effect<ReadonlyArray<AttemptChannel.WorkerNotice>>;
  /** Whether `Started` was reserved. */
  readonly started: Effect.Effect<boolean>;
  /** Whether a terminal envelope was reserved. */
  readonly ended: Effect.Effect<boolean>;
}

const unavailable = () =>
  AgentFailure.make({ message: "This attempt no longer has a live channel" });

const isTerminal = (payload: AttemptChannel.OutboundPayload) =>
  payload._tag === "Final" || payload._tag === "Failed" || payload._tag === "Interrupted";

/** Returns the `Started` payload of an Attempt without a parent session. */
export const startedWithoutParent = (spec: AttemptChannel.RunSpec) =>
  AttemptChannel.Started.make({
    parentModel: Option.none(),
    conflictingSalvage: spec.conflictingSalvage,
  });

/** Returns the outbox relay of one Attempt. */
export const outboxFor = Effect.fn("Outbox.open")(function* (
  journal: AttemptJournal["Service"],
  attemptId: AttemptId,
) {
  const emission = yield* Semaphore.make(1);
  let channel = Option.none<Channel>();
  let kept: ReadonlyArray<AttemptChannel.WorkerNotice> = [];
  let started = false;
  let ended = false;

  const deliver = (attachedChannel: Channel) =>
    Effect.gen(function* () {
      const pending = attachedChannel.pending;
      const last = pending.at(-1);
      if (last === undefined) return;
      for (const envelope of pending)
        yield* attachedChannel.io.append("outbound", envelope).pipe(
          Effect.tapError((failure) =>
            Effect.logWarning("Outbound delivery failed; the envelopes stay reserved", {
              attemptId,
              sequence: envelope.sequence,
              failure: failure._tag,
            }),
          ),
        );
      yield* journal.acknowledge(attemptId, last.sequence);
      attachedChannel.pending = [];
      yield* Effect.logDebug("Delivered the Attempt's reserved envelopes", {
        attemptId,
        envelopes: pending.length,
        through: last.sequence,
      });
    });

  const envelopes = (
    attachedChannel: Channel,
    payloads: ReadonlyArray<AttemptChannel.OutboundPayload>,
  ) =>
    Effect.map(DateTime.now, (sentAt) =>
      payloads.map((payload, index) =>
        AttemptChannel.OutboundEnvelope.make({
          version: AttemptChannel.PROTOCOL_VERSION,
          attemptId,
          sequence: AttemptChannel.Sequence.make(attachedChannel.next + index),
          sentAt,
          payload,
        }),
      ),
    );

  /** Reserves and delivers `payloads`. The caller holds the emission permit. */
  const commitHeld = <A, E>(
    payloads: ReadonlyArray<AttemptChannel.OutboundPayload>,
    write: (outbound: ReadonlyArray<AttemptChannel.OutboundEnvelope>) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      // The channel admits no envelope after its terminal envelope.
      if (Option.isNone(channel) || ended) return yield* unavailable();
      const attachedChannel = channel.value;
      const outbound = yield* envelopes(attachedChannel, payloads);
      const written = yield* write(outbound);
      attachedChannel.next = AttemptChannel.Sequence.make(attachedChannel.next + outbound.length);
      attachedChannel.pending.push(...outbound);
      if (payloads.some(({ _tag }) => _tag === "Started")) started = true;
      if (payloads.some(isTerminal)) ended = true;
      yield* deliver(attachedChannel);
      return written;
    });

  const commit = <A, E>(
    payloads: ReadonlyArray<AttemptChannel.OutboundPayload>,
    write: (outbound: ReadonlyArray<AttemptChannel.OutboundEnvelope>) => Effect.Effect<A, E>,
  ) => emission.withPermits(1)(commitHeld(payloads, write));

  /** Reports `failure` to the attached call, which fails the Attempt. */
  const reportFailure =
    (payloads: ReadonlyArray<AttemptChannel.OutboundPayload>) =>
    (failure: AttemptFailure | JournalError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Could not relay the Attempt's activity; the Attempt fails", {
          attemptId,
          payloads: payloads.map(({ _tag }) => _tag),
          errorTag: failure._tag,
          message: failure.message,
        });
        if (Option.isSome(channel)) yield* Deferred.fail(channel.value.failed, failure);
      });

  const emit = (payloads: ReadonlyArray<AttemptChannel.OutboundPayload>) =>
    commit(payloads, (outbound) => journal.reserve(attemptId, outbound));

  const relay = (payloads: ReadonlyArray<AttemptChannel.OutboundPayload>) =>
    emit(payloads).pipe(Effect.catch(reportFailure(payloads)));

  const inbound = (intervention: AttemptChannel.Intervention) =>
    emission.withPermits(1)(
      Effect.gen(function* () {
        if (Option.isNone(channel)) return yield* unavailable();
        const attachedChannel = channel.value;
        const envelope = AttemptChannel.InboundEnvelope.make({
          version: AttemptChannel.PROTOCOL_VERSION,
          attemptId,
          sequence: attachedChannel.inbound,
          sentAt: yield* DateTime.now,
          target: intervention.target,
          operator: intervention.operator,
          payload: intervention.action,
        });
        // Recorded first, so a stop before the append skips the sequence instead of reusing it.
        yield* journal.recordInbound(attemptId, envelope.sequence);
        attachedChannel.inbound = AttemptChannel.Sequence.make(envelope.sequence + 1);
        yield* attachedChannel.io.append("inbound", envelope);
        return envelope.sequence;
      }),
    );

  const attach = (io: AttemptChannel.Sink, snapshot: CoordinatorSnapshot) =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<never, AttemptFailure | JournalError>();
      const attachedHere = yield* Effect.acquireRelease(
        Effect.sync(() => {
          if (Option.isSome(channel)) return false;
          channel = Option.some({
            io,
            pending: [...snapshot.outbox],
            next: snapshot.nextOutbound,
            inbound: snapshot.nextInbound,
            failed,
          });
          started = snapshot.nextOutbound > 1;
          ended = snapshot.status._tag !== "Open";
          return true;
        }),
        (attachedHere) =>
          attachedHere
            ? Effect.sync(() => {
                channel = Option.none();
              }).pipe(
                Effect.andThen(Effect.logDebug("Detached the Attempt's channel", { attemptId })),
              )
            : Effect.void,
      );
      if (!attachedHere) return false;
      if (snapshot.outbox.length > 0)
        yield* Effect.logInfo("Replaying the Attempt's reserved envelopes", {
          attemptId,
          envelopes: snapshot.outbox.length,
          nextSequence: snapshot.nextOutbound,
        });
      yield* emission.withPermits(1)(
        Effect.suspend(() => (Option.isSome(channel) ? deliver(channel.value) : Effect.void)),
      );
      return true;
    });

  const notice = (workerNotice: AttemptChannel.WorkerNotice) =>
    emission.withPermits(1)(
      Effect.gen(function* () {
        if (ended) return { _tag: "Dropped" } satisfies NoticeRouting;
        if (Option.isNone(channel) || !started) {
          kept = keepNotice(kept, workerNotice);
          return { _tag: "Kept", kept } satisfies NoticeRouting;
        }
        yield* commitHeld([workerNotice], (outbound) => journal.reserve(attemptId, outbound)).pipe(
          Effect.catch(reportFailure([workerNotice])),
        );
        return { _tag: "Relayed" } satisfies NoticeRouting;
      }),
    );

  return {
    attach,
    attached: Effect.sync(() => Option.isSome(channel)),
    failed: Effect.suspend(() =>
      Option.match(channel, {
        onNone: () => Effect.never,
        onSome: ({ failed }) => Deferred.await(failed),
      }),
    ).pipe(Effect.flip),
    emit,
    relay,
    inbound,
    commit,
    notice,
    takeKept: Effect.sync(() => {
      const taken = kept;
      kept = [];
      return taken;
    }),
    started: Effect.sync(() => started),
    ended: Effect.sync(() => ended),
  } satisfies Outbox;
});
