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
 * Whether a child read an operator input it had queued: the child's state
 * when it read it, or none when it stopped first.
 */
export interface ChildDelivery {
  readonly _tag: "Delivery";
  readonly inputSequence: AttemptChannel.Sequence;
  readonly intervention: AttemptChannel.Intervention;
  readonly delivered: Option.Option<AttemptChannel.InterventionState>;
}

/** Activity waiting to be relayed, in the order it happened in this process. */
export type RelayItem =
  | { readonly _tag: "Entry"; readonly entry: EntryId }
  | { readonly _tag: "Event"; readonly event: AgentSessionEvent }
  | { readonly _tag: "Notice"; readonly notice: AttemptChannel.WorkerNotice }
  | ChildDelivery
  | { readonly _tag: "Wake" };

/** How far the attached channel has progressed; persisted in the Attempt's record after each parent entry and each other envelope. */
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

/** In-process state of one Attempt: its relay queue, its attached channel, and its live children. */
export interface AttemptHub {
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
  readonly queue: Queue.Queue<RelayItem>;
  /** Serializes outbound envelopes between the relay and interventions. */
  readonly emission: Semaphore.Semaphore;
  /** Applies one operator intervention at a time. */
  readonly routing: Semaphore.Semaphore;
  /** Live children by id, so an operator message can be addressed to one. */
  readonly children: Map<AgentSessionId, RunningSession>;
  /**
   * Input sequences of the operator inputs a child of this process queued and
   * has not reported read or unread yet. A queued child input missing here was
   * queued by a process that stopped, so its child is gone.
   */
  readonly childInputs: Set<number>;
  parent: Option.Option<ConversationId>;
  channel: Option.Option<AttachedChannel>;
  /**
   * Completed with the request of the `execute` call relaying this Attempt, and
   * replaced when it detaches. Its child host and environment are never
   * stored, so new children wait for a live `execute` to supply them.
   */
  attached: Deferred.Deferred<AttemptRequest>;
}

export interface AttemptHubs {
  /** The Attempt's hub, created on first use. */
  readonly hub: (attemptId: AttemptId, taskId: TaskId) => Effect.Effect<AttemptHub>;
  readonly find: (attemptId: AttemptId) => Option.Option<AttemptHub>;
  /** Routes the parent conversation's entries to the hub from now on. */
  readonly bindParent: (hub: AttemptHub, parent: ConversationId) => void;
  /** Queues one session event that no parent entry stands for, a child's or the parent's own, behind everything that happened before it. */
  readonly event: (hub: AttemptHub, event: AgentSessionEvent) => Effect.Effect<void>;
  /** Queues one notice about the Attempt's Worker behind everything that happened before it. */
  readonly notice: (hub: AttemptHub, notice: AttemptChannel.WorkerNotice) => Effect.Effect<void>;
  /** Queues the report of whether a child read an operator input it had queued. */
  readonly delivery: (hub: AttemptHub, delivery: ChildDelivery) => Effect.Effect<void>;
  /** Routes commits to hubs: parent entries in order, task and record changes as wake-ups; wakes every hub after a reopen or the stop. */
  readonly listener: HarnessListener;
}

export const attemptHubs = Effect.gen(function* () {
  const creation = yield* Semaphore.make(1);
  const byAttempt = new Map<string, AttemptHub>();
  const byTask = new Map<number, AttemptHub>();
  const byParent = new Map<number, AttemptHub>();

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
        const created: AttemptHub = {
          attemptId,
          taskId,
          queue: yield* Queue.unbounded<RelayItem>(),
          emission: yield* Semaphore.make(1),
          routing: yield* Semaphore.make(1),
          children: new Map(),
          childInputs: new Set(),
          parent: Option.none(),
          channel: Option.none(),
          attached: yield* Deferred.make<AttemptRequest>(),
        };
        byAttempt.set(attemptId, created);
        byTask.set(taskId, created);
        yield* Effect.logDebug("Tracking the Attempt in this process", { attemptId, taskId });
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
    notice: (target, notice) =>
      Queue.offer(target.queue, { _tag: "Notice", notice }).pipe(Effect.asVoid),
    delivery: (target, delivery) => Queue.offer(target.queue, delivery).pipe(Effect.asVoid),
    listener,
  } satisfies AttemptHubs;
});
