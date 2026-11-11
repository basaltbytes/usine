import { ChildRequest } from "@usine/agents/runtime";
import {
  type AgentSessionId,
  ChildSession,
  type ChildSessionBudget,
  HarnessSession,
} from "@usine/core/agent/session";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { MachineId, WorkerName } from "@usine/core/worker";
import { type Brand, type Effect, type Option, Schema } from "effect";
import type { DurableHarnessError } from "../../harness.ts";

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

/**
 * The first blocker, question, or harness failure that a child of the Attempt reported, which fails
 * the Attempt unless its coordinator relays one.
 */
export interface ChildBlocker {
  readonly sessionId: string;
  readonly message: string;
  readonly kind: "blocked" | "question" | "failed" | "capacity" | "infra";
  /** The ISO 8601 time a capacity report's usage limit resets, if known. */
  readonly resetsAt?: string;
}

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

/** The result of `DelegationJournal.start`. */
interface DelegationStart {
  /** The delegation's number among the Attempt's delegations, refused ones included. */
  readonly count: number;
  /** Whether an earlier run of the delegation counted it, as before a restart. */
  readonly resumed: boolean;
  readonly progress: DelegationProgress;
  /** The session whose infrastructure failure the start cleared. */
  readonly superseded: Option.Option<string>;
}

/** An operator input queued for a child and not yet reported read. */
export interface QueuedChildInput {
  readonly inputSequence: number;
  readonly intervention: typeof AttemptChannel.Intervention.Encoded;
}

/**
 * The durable state of one delegation and the parts of its Attempt that the delegation reads and
 * changes. Each operation is atomic. Operations fail with a `DurableHarnessError` that names the
 * step.
 */
export interface DelegationJournal {
  /**
   * Records the delegation's start. The first call counts the delegation as the Attempt's next one.
   * Past `budget`, it records the Attempt's first refused delegation; within it, it clears the
   * Attempt's child blocker if `supersedes` accepts it. A later call returns the same count and the
   * progress saved since, and changes nothing.
   */
  readonly start: (
    budget: ChildSessionBudget,
    supersedes: (blocker: ChildBlocker) => boolean,
  ) => Effect.Effect<DelegationStart, DurableHarnessError>;
  /**
   * Records `blocker` as the Attempt's child blocker unless the Attempt has one that `keeps`
   * accepts. Returns whether it recorded `blocker`.
   */
  readonly recordBlocker: (
    blocker: ChildBlocker,
    keeps: (current: ChildBlocker) => boolean,
  ) => Effect.Effect<boolean, DurableHarnessError>;
  /** Clears the Attempt's child blocker if `accept` matches it. Returns whether it cleared one. */
  readonly clearBlocker: (
    accept: (current: ChildBlocker) => boolean,
  ) => Effect.Effect<boolean, DurableHarnessError>;
  /** Reads the operator inputs queued for the child, oldest first. */
  readonly queuedInputs: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<ReadonlyArray<QueuedChildInput>, DurableHarnessError>;
  /** Reads whether the operator holds or pauses the child. */
  readonly supervision: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<{ readonly held: boolean; readonly paused: boolean }, DurableHarnessError>;
  /** Completes when the operator does not hold the child, starting with the current Hold. */
  readonly holdEnded: (sessionId: AgentSessionId) => Effect.Effect<void, DurableHarnessError>;
  /** Removes the child from the operator's Hold and pause. */
  readonly releaseSupervision: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<void, DurableHarnessError>;
  /**
   * Saves the child's conversation. With `beforePrompt`, the delegation's first save also records
   * that the child has not received its prompt.
   */
  readonly saveSession: (
    saved: typeof SavedChild.Encoded,
    options: { readonly beforePrompt: boolean },
  ) => Effect.Effect<void, DurableHarnessError>;
  /** Records that the child received its prompt. */
  readonly savePrompted: Effect.Effect<void, DurableHarnessError>;
  /** Saves the times of the child's continuation turns. */
  readonly saveContinuations: (
    timestamps: ReadonlyArray<number>,
  ) => Effect.Effect<void, DurableHarnessError>;
  /** Saves the child's cumulative usage with its saved conversation, if one is saved. */
  readonly saveUsage: (
    usage: typeof ChildRequest.fields.usage.Encoded,
  ) => Effect.Effect<void, DurableHarnessError>;
  /** Records a started tool call of the child, replacing one with the same `callId`. */
  readonly toolStarted: (callId: string, tool: string) => Effect.Effect<void, DurableHarnessError>;
  readonly toolFinished: (callId: string) => Effect.Effect<void, DurableHarnessError>;
  /** Saves the child's report while it waits idle, or `None` when it works or finishes. */
  readonly saveIdle: (report: Option.Option<string>) => Effect.Effect<void, DurableHarnessError>;
  /** Appends `chunk` to the delegation's running output. */
  readonly output: (chunk: string) => Effect.Effect<void, DurableHarnessError>;
  /** Saves the running output retained so far, which a resumed delegation restores. */
  readonly saveOutput: Effect.Effect<void, DurableHarnessError>;
  /** The running output retained so far. */
  readonly retainedOutput: Effect.Effect<string>;
  /** Replaces the delegation's running details. */
  readonly publish: (details: DelegationDetails) => Effect.Effect<void, DurableHarnessError>;
  /** Completes when the owner of the delegation aborts it, such as at harness shutdown. */
  readonly aborted: Effect.Effect<void>;
}
