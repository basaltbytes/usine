import { ChildRequest, type RunningSession } from "@usine/agents/runtime";
import {
  type AgentSessionEvent,
  type AgentSessionId,
  ChildSession,
  type ChildSessionBudget,
  type ChildSessionCount,
  HarnessSession,
} from "@usine/core/agent/session";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { MachineId, WorkerName } from "@usine/core/worker";
import {
  type Brand,
  type Deferred,
  type Effect,
  type Option,
  Schema,
  type Semaphore,
} from "effect";
import type { AttemptRequest } from "../../attempt-runtime.ts";
import type { JournalError } from "../../coordinator/journal.ts";

/** The saved conversation and worker that belong to one durable delegation. */
export class SavedChild extends Schema.Class<
  SavedChild,
  Brand.Brand<"@usine/durable/attempt/delegation/journal/SavedChild">
>("@usine/durable/SavedChild")({
  session: Schema.Struct({
    id: ChildSession.fields.id,
    parentId: ChildSession.fields.parentId,
    agent: ChildSession.fields.agent,
    brain: ChildSession.fields.brain,
  }),
  usage: ChildRequest.fields.usage,
  harnessSession: HarnessSession,
  worker: WorkerName,
  machine: Schema.OptionFromNullOr(MachineId),
}) {}

/** The running details of a delegation: the child's session ID and its saved conversation. */
export type DelegationDetails = {
  childSessionId: string;
  saved?: typeof SavedChild.Encoded;
};

/** The progress that earlier runs of a delegation saved. */
export interface DelegationProgress {
  /** The child's output so far. */
  readonly output: string;
  /** The saved child conversation as stored, which may no longer decode. */
  readonly saved: Option.Option<unknown>;
  /** The child's report while it waited idle under a Hold. */
  readonly idle: Option.Option<string>;
  /** The times of the continuation turns, in epoch milliseconds. */
  readonly continuations: ReadonlyArray<number>;
  /** The child's tool calls that started and did not finish. */
  readonly inFlight: ReadonlyArray<{ readonly callId: string; readonly tool: string }>;
  /** Whether the child received its prompt. */
  readonly prompted: boolean;
}

/** A delegation that its owner numbered and admitted within the child-session budget. */
interface Admitted {
  readonly _tag: "Admitted";
  /** The delegation's number among the Attempt's delegations, which names its child session. */
  readonly count: ChildSessionCount;
  /** Whether an earlier run of the delegation started it, as before a restart. */
  readonly resumed: boolean;
  readonly progress: DelegationProgress;
}

/** A delegation that its owner refused because the Attempt spent its child-session budget. */
interface Refused {
  readonly _tag: "Refused";
  /** The child count including the refused delegation. */
  readonly attempted: ChildSessionCount;
  readonly max: ChildSessionBudget;
}

/** The result of `DelegationJournal.start`. */
export type DelegationStart = Admitted | Refused;

/** An operator input queued for a child and not yet reported read. */
export interface QueuedChildInput {
  readonly inputSequence: number;
  /** The encoded intervention as stored, which may no longer decode. */
  readonly intervention: unknown;
}

/**
 * The durable state of one delegation and the supervision of its child. Each operation is atomic.
 *
 * The journal's owner numbers delegations and applies the child-session budget in `start`: the Pi
 * parent's `subagent` tool counts each call, and the event-driven coordinator numbers each
 * delegation in the transition that decided it.
 */
export interface DelegationJournal {
  /**
   * Records the delegation's start, or refuses it over the child-session budget. A later call
   * returns the same number with the progress saved since, and changes nothing.
   */
  readonly start: Effect.Effect<DelegationStart, JournalError>;
  /** Reads the operator inputs queued for the child, oldest first. */
  readonly queuedInputs: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<ReadonlyArray<QueuedChildInput>, JournalError>;
  /** Reads whether the operator holds or pauses the child. */
  readonly supervision: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<{ readonly held: boolean; readonly paused: boolean }, JournalError>;
  /** Completes when the operator does not hold the child, starting with the current Hold. */
  readonly holdEnded: (sessionId: AgentSessionId) => Effect.Effect<void, JournalError>;
  /** Removes the child from the operator's Hold and pause. */
  readonly releaseSupervision: (sessionId: AgentSessionId) => Effect.Effect<void, JournalError>;
  /**
   * Saves the child's conversation. With `beforePrompt`, the delegation's first save also records
   * that the child has not received its prompt.
   */
  readonly saveSession: (
    saved: typeof SavedChild.Encoded,
    options: { readonly beforePrompt: boolean },
  ) => Effect.Effect<void, JournalError>;
  /** Records that the child received its prompt. */
  readonly savePrompted: Effect.Effect<void, JournalError>;
  /** Saves the times of the child's continuation turns. */
  readonly saveContinuations: (
    timestamps: ReadonlyArray<number>,
  ) => Effect.Effect<void, JournalError>;
  /** Saves the child's cumulative usage with its saved conversation, if one is saved. */
  readonly saveUsage: (
    usage: typeof ChildRequest.fields.usage.Encoded,
  ) => Effect.Effect<void, JournalError>;
  /** Records a started tool call of the child, replacing one with the same `callId`. */
  readonly toolStarted: (callId: string, tool: string) => Effect.Effect<void, JournalError>;
  readonly toolFinished: (callId: string) => Effect.Effect<void, JournalError>;
  /** Saves the child's report while it waits idle, or `None` when it works or finishes. */
  readonly saveIdle: (report: Option.Option<string>) => Effect.Effect<void, JournalError>;
  /** Saves the running output retained so far, which a resumed delegation restores. */
  readonly saveOutput: (output: string) => Effect.Effect<void, JournalError>;
}

/** A blocker, question, harness failure, or capacity refusal that a child ended with. */
export interface ReservedChildReport {
  readonly kind: "blocked" | "question" | "failed" | "capacity";
  readonly message: string;
  /** The time a capacity refusal's usage limit resets, if the provider reported one. */
  readonly resetsAt: Option.Option<string>;
}

/**
 * The call that runs one delegation: a Pi parent's `subagent` tool call, or the event-driven
 * coordinator. It owns the running output and decides what a child's failure means for the
 * Attempt.
 */
export interface DelegationCall {
  /** Appends `chunk` to the delegation's running output. */
  readonly output: (chunk: string) => Effect.Effect<void, JournalError>;
  /** The running output retained so far. */
  readonly retainedOutput: Effect.Effect<string>;
  /** Replaces the delegation's running details. */
  readonly publish: (details: DelegationDetails) => Effect.Effect<void, JournalError>;
  /** Completes when the owner aborts the delegation, such as at shutdown or cancellation. */
  readonly aborted: Effect.Effect<void>;
  /** Records that a new child's session failed in a way the engine retries. */
  readonly infrastructureFailed: (
    sessionId: AgentSessionId,
    message: string,
  ) => Effect.Effect<void, JournalError>;
  /** Records the reserved report that the child ended with. */
  readonly reserved: (
    sessionId: AgentSessionId,
    report: ReservedChildReport,
  ) => Effect.Effect<void, JournalError>;
  /** Records that a resumed child returned, which supersedes its infrastructure failure. */
  readonly recovered: (sessionId: AgentSessionId) => Effect.Effect<void, JournalError>;
}

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

/** The in-process state of an Attempt that its delegations share. */
export interface DelegationHub {
  /** The live children by session ID. */
  readonly children: Map<AgentSessionId, RunningSession>;
  /** Child delegations admitted in this process, including children that have finished. */
  readonly childSpawns: Set<string>;
  /**
   * The sequence numbers of operator inputs queued by children in this process and not yet
   * reported read or unread.
   */
  readonly childInputs: Set<number>;
  /** Serializes operator interventions. */
  readonly routing: Semaphore.Semaphore;
  /**
   * Completes with the request of the `execute` call relaying the Attempt. Replaced when that call
   * detaches, so read it at each use.
   */
  readonly attached: Deferred.Deferred<AttemptRequest>;
  /** Relays a session event of a child. */
  readonly event: (event: AgentSessionEvent) => Effect.Effect<void>;
  /** Relays whether a child read a queued operator input. */
  readonly delivery: (delivery: ChildDelivery) => Effect.Effect<void>;
}
