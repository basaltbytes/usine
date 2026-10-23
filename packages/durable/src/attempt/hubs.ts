import type { ConversationId, EntryId, TaskId } from "@earendil-works/pi-durable";
import type { RunningSession } from "@usine/agents/runtime";
import type { AgentSessionEvent, AgentSessionId } from "@usine/core/agent/session";
import type { AttemptId } from "@usine/core/attempt";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { Deferred, Effect, Option, Queue, Semaphore } from "effect";
import type { AttemptRequest } from "../attempt-runtime.ts";
import type { HarnessListener } from "../harness.ts";
import { ATTEMPT_RECORD_KIND, type AttemptRecord } from "./documents.ts";

/**
 * Whether a child read a queued operator input, with the child's state when it read it, or `None`
 * if it stopped first.
 */
export interface ChildDelivery {
  readonly _tag: "Delivery";
  readonly inputSequence: AttemptChannel.Sequence;
  readonly intervention: AttemptChannel.Intervention;
  readonly delivered: Option.Option<AttemptChannel.InterventionState>;
}

/** Activity queued for relay, in order of occurrence. */
export type RelayItem =
  | { readonly _tag: "Entry"; readonly entry: EntryId }
  | { readonly _tag: "Event"; readonly event: AgentSessionEvent }
  | { readonly _tag: "Notice"; readonly notice: AttemptChannel.WorkerNotice }
  | ChildDelivery
  | { readonly _tag: "Wake" };

/**
 * The relay position of the attached channel, persisted in the Attempt record after each parent
 * entry and envelope.
 */
export interface RelayProgress {
  outbound: AttemptChannel.Progress;
  inbound: number;
  entry: number;
  tokens: number;
}

/** The sink of the `execute` call relaying this Attempt. */
interface AttachedChannel {
  readonly io: AttemptChannel.Sink;
  readonly progress: RelayProgress;
}

/** The in-process state of one Attempt. */
export interface AttemptHub {
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
  readonly queue: Queue.Queue<RelayItem>;
  /** Serializes outbound envelopes between the relay and interventions. */
  readonly emission: Semaphore.Semaphore;
  /** Serializes operator interventions. */
  readonly routing: Semaphore.Semaphore;
  /** The live children by session ID. */
  readonly children: Map<AgentSessionId, RunningSession>;
  /**
   * The sequence numbers of operator inputs queued by children in this process and not yet reported
   * read or unread. An input missing from this set was queued by a previous process.
   */
  readonly childInputs: Set<number>;
  parent: Option.Option<ConversationId>;
  channel: Option.Option<AttachedChannel>;
  /** The Worker notices received before the parent started, sent right after `Started`. */
  early: ReadonlyArray<AttemptChannel.WorkerNotice>;
  /**
   * Completes with the request of the `execute` call relaying this Attempt. Replaced when that call
   * detaches.
   */
  attached: Deferred.Deferred<AttemptRequest>;
}

/**
 * Returns the notices to buffer after `notice`: the latest one, preceded by the last
 * `WorkerUnresponsive` if the latest is a `WorkerResponsive`.
 */
export const keepNotice = (
  kept: ReadonlyArray<AttemptChannel.WorkerNotice>,
  notice: AttemptChannel.WorkerNotice,
): ReadonlyArray<AttemptChannel.WorkerNotice> => {
  const previous = kept.at(-1);
  return notice._tag === "WorkerResponsive" && previous?._tag === "WorkerUnresponsive"
    ? [previous, notice]
    : [notice];
};

/** The result of `AttemptHubs.notice`. */
export type NoticeRouting =
  | { readonly _tag: "Queued" }
  | { readonly _tag: "Kept"; readonly kept: ReadonlyArray<AttemptChannel.WorkerNotice> };

export interface AttemptHubs {
  /** Returns the Attempt's hub, creating it on first use with the buffered Worker notices. */
  readonly hub: (attemptId: AttemptId, taskId: TaskId) => Effect.Effect<AttemptHub>;
  readonly find: (attemptId: AttemptId) => Option.Option<AttemptHub>;
  /** Routes the parent conversation's entries to the hub from now on. */
  readonly bindParent: (hub: AttemptHub, parent: ConversationId) => void;
  /** Queues a session event that has no parent entry. */
  readonly event: (hub: AttemptHub, event: AgentSessionEvent) => Effect.Effect<void>;
  /**
   * Queues a Worker notice. If the Attempt has no hub in this process, buffers it with `keepNotice`
   * until the hub is created.
   */
  readonly notice: (
    attemptId: AttemptId,
    notice: AttemptChannel.WorkerNotice,
  ) => Effect.Effect<NoticeRouting>;
  readonly delivery: (hub: AttemptHub, delivery: ChildDelivery) => Effect.Effect<void>;
  /**
   * Completes when an `execute` call is relaying the Attempt, even if the hub doesn't exist yet.
   */
  readonly attached: (attemptId: AttemptId) => Effect.Effect<void>;
  /** Routes commits to hubs and wakes every hub after a reopen or stop. */
  readonly listener: HarnessListener;
}

export const attemptHubs = Effect.gen(function* () {
  const creation = yield* Semaphore.make(1);
  const byAttempt = new Map<string, AttemptHub>();
  const byTask = new Map<number, AttemptHub>();
  const byParent = new Map<number, AttemptHub>();
  /** The Worker notices for Attempts without a hub. */
  const early = new Map<string, ReadonlyArray<AttemptChannel.WorkerNotice>>();
  /**
   * The Deferreds that `attached` waits on for Attempts without a hub. A new hub uses this
   * Deferred.
   */
  const awaited = new Map<string, Deferred.Deferred<AttemptRequest>>();

  const bindParent = (hub: AttemptHub, parent: ConversationId) => {
    if (Option.isSome(hub.parent)) return;
    hub.parent = Option.some(parent);
    byParent.set(parent, hub);
  };

  const wake = (hub: AttemptHub) => Queue.offerUnsafe(hub.queue, { _tag: "Wake" });

  const hub = (attemptId: AttemptId, taskId: TaskId) =>
    creation.withPermits(1)(
      Effect.gen(function* () {
        const existing = byAttempt.get(attemptId);
        if (existing !== undefined) return existing;
        const queue = yield* Queue.unbounded<RelayItem>();
        const emission = yield* Semaphore.make(1);
        const routing = yield* Semaphore.make(1);
        const fresh = yield* Deferred.make<AttemptRequest>();
        // No yield until the hub is registered, so a concurrent `notice` or `attached` sees either
        // the pre-hub buffers or the registered hub.
        const attached = awaited.get(attemptId) ?? fresh;
        const created: AttemptHub = {
          attemptId,
          taskId,
          queue,
          emission,
          routing,
          children: new Map(),
          childInputs: new Set(),
          parent: Option.none(),
          channel: Option.none(),
          early: early.get(attemptId) ?? [],
          attached,
        };
        early.delete(attemptId);
        awaited.delete(attemptId);
        byAttempt.set(attemptId, created);
        byTask.set(taskId, created);
        yield* Effect.logDebug("Tracking the Attempt in this process", {
          attemptId,
          taskId,
          earlyNotices: created.early.map(({ _tag }) => _tag),
          awaitedAttachment: attached !== fresh,
        });
        return created;
      }),
    );

  const listener: HarnessListener = {
    onCommit: (publication) => {
      for (const change of publication.changes) {
        if (change.type === "task") {
          const target = byTask.get(change.value.id);
          if (target !== undefined) wake(target);
        } else if (
          change.type === "document" &&
          change.record.kind === ATTEMPT_RECORD_KIND &&
          change.record.key !== undefined &&
          change.value !== null
        ) {
          const target = byAttempt.get(change.record.key);
          // SAFETY: documents of this kind are only written through AttemptRecordDoc.
          const record = change.value as AttemptRecord;
          if (
            target !== undefined &&
            Option.isNone(target.parent) &&
            record.parentConversation !== null
          ) {
            bindParent(target, record.parentConversation);
            wake(target);
          }
        }
      }
      for (const change of publication.changes) {
        if (change.type !== "entry") continue;
        const target = byParent.get(change.value.conversationId);
        if (target !== undefined) {
          Queue.offerUnsafe(target.queue, { _tag: "Entry", entry: change.value.id });
        }
      }
    },
    onReopen: () => {
      for (const target of byAttempt.values()) wake(target);
    },
    onStop: () => {
      for (const target of byAttempt.values()) wake(target);
    },
  };

  return {
    hub,
    find: (attemptId) => Option.fromNullishOr(byAttempt.get(attemptId)),
    bindParent,
    event: (target, event) =>
      Queue.offer(target.queue, { _tag: "Event", event }).pipe(Effect.asVoid),
    notice: (attemptId, notice) =>
      Effect.sync((): NoticeRouting => {
        const target = byAttempt.get(attemptId);
        if (target !== undefined) {
          Queue.offerUnsafe(target.queue, { _tag: "Notice", notice });
          return { _tag: "Queued" };
        }
        const kept = keepNotice(early.get(attemptId) ?? [], notice);
        early.set(attemptId, kept);
        return { _tag: "Kept", kept };
      }),
    delivery: (target, delivery) => Queue.offer(target.queue, delivery).pipe(Effect.asVoid),
    // Read `attached` at call time: `relayAttempt` replaces it when the channel detaches.
    attached: (attemptId) =>
      Effect.suspend(() => {
        const target = byAttempt.get(attemptId);
        if (target !== undefined) return Deferred.await(target.attached);
        const kept = awaited.get(attemptId) ?? Deferred.makeUnsafe<AttemptRequest>();
        awaited.set(attemptId, kept);
        return Deferred.await(kept);
      }).pipe(Effect.asVoid),
    listener,
  } satisfies AttemptHubs;
});
