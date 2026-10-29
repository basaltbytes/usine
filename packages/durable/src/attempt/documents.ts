import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";
import type * as AttemptChannel from "@usine/core/attempt/channel";

/**
 * The return value of a completed `usine.attempt` task. `answeredOperator` is absent on older
 * results.
 */
export type AttemptResult = { message: string; answeredOperator?: boolean };

/**
 * An accepted, unread operator input, queued either by the busy parent (with its submission) or by
 * a working child (with its session ID).
 */
type QueuedInput =
  | {
      inputSequence: number;
      submission: SubmissionId;
      intervention: typeof AttemptChannel.Intervention.Encoded;
    }
  | {
      inputSequence: number;
      child: string;
      intervention: typeof AttemptChannel.Intervention.Encoded;
    };

/** The durable record of one Attempt, keyed by Attempt ID and kept after the task ends. */
export type AttemptRecord = {
  /** Written in the same commit as the task. */
  taskId: TaskId<AttemptResult> | null;
  /** The parent model resolved at start. */
  parentModel: string | null;
  parentConversation: ConversationId | null;
  /** The number of child spawn requests, including those rejected by the child-session budget. */
  children: number;
  /**
   * The first blocker, question, or harness failure reported by a child, which fails the Attempt
   * unless the parent relays one. A missing `kind` means `blocked`.
   */
  childBlocker: {
    sessionId: string;
    message: string;
    kind?: "blocked" | "question" | "failed";
  } | null;
  childBudgetExceeded: { attempted: number; max: number } | null;
  /** The next outbound and inbound sequence numbers. */
  nextOutbound: number;
  nextInbound: number;
  /**
   * The newest parent entry whose session events were all relayed, and the parent's last relayed
   * token count.
   */
  relayedEntry: number;
  relayedTokens: number;
  terminalRelayed: boolean;
  /** The caller confirmed cancellation and stopped relaying. Absent means false on older records. */
  settled?: boolean;
  /** The harvested `StepResult` as JSON, absent until the executor records it. */
  result?: string;
  /**
   * The reason the parent conversation couldn't be read from storage. Written before the task is
   * aborted, so the Attempt fails with it.
   */
  storageFailure?: string;
  /** Operator inputs with a queued receipt and no delivery receipt, oldest first. */
  queuedInputs?: QueuedInput[];
  /**
   * The unsupervised time in milliseconds, as last recorded by a runaway guard with a wall-clock
   * ceiling.
   */
  unsupervisedMillis?: number;
};

export const ATTEMPT_RECORD_KIND = "usine.attempt";

export const AttemptRecordDoc = defineDocFamily<AttemptRecord, null>({
  kind: ATTEMPT_RECORD_KIND,
  version: 1,
  scope: "session",
  family: true,
  checkpointWhen: () => false,
  initial: () => ({
    taskId: null,
    parentModel: null,
    parentConversation: null,
    children: 0,
    childBlocker: null,
    childBudgetExceeded: null,
    nextOutbound: 1,
    nextInbound: 1,
    relayedEntry: 0,
    relayedTokens: 0,
    terminalRelayed: false,
    settled: false,
  }),
});

/**
 * The operator supervision state of one running Attempt (ADR 0018), scoped to its task. `held`
 * lists the session IDs under a Hold, including the parent's.
 */
export type Hold = {
  paused: boolean;
  guidance: string[];
  held: string[];
};

/** The message sent to a released parent if the operator provided none. */
export const RELEASE_GUIDANCE =
  "The operator released you without further guidance. Continue the task; if it is already done, give your final answer.";

export const HoldDoc = defineDoc<Hold>({
  kind: "usine.hold",
  version: 1,
  scope: "task",
  checkpointWhen: () => false,
  initial: () => ({ paused: false, guidance: [], held: [] }),
});
