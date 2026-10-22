import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";
import type * as AttemptChannel from "@usine/core/attempt/channel";

/**
 * What a completed `usine.attempt` task returns: the parent's final message,
 * and whether its last turn answered operator input without delegating after
 * it. Results recorded before `answeredOperator` existed have none.
 */
export type AttemptResult = { message: string; answeredOperator?: boolean };

/**
 * An operator input a session accepted and has not read yet: one submitted to
 * the busy parent, with its pi-durable submission, or one a working child
 * queued, with the child's session id.
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

/**
 * One Attempt's durable record, keyed by Attempt id. It outlives the task, so
 * a later `execute` finds the task and continues the channel where it stopped.
 */
export type AttemptRecord = {
  /** Committed in the same commit as the task, so a crash never leaves a task without its index. */
  taskId: TaskId<AttemptResult> | null;
  /** The parent model resolved at start, reported in the `Started` envelope. */
  parentModel: string | null;
  parentConversation: ConversationId | null;
  /** Child spawn requests so far, including requests rejected by the child-session budget. */
  children: number;
  /**
   * The first report of a child: a blocker, an operator question, or a
   * harness failure (`failed`). It fails the Attempt unless the parent relays
   * one itself. Records written before questions existed have no `kind` and
   * hold a blocker; records written before `failed` existed hold a harness
   * failure as a blocker.
   */
  childBlocker: {
    sessionId: string;
    message: string;
    kind?: "blocked" | "question" | "failed";
  } | null;
  childBudgetExceeded: { attempted: number; max: number } | null;
  /** The next outbound and inbound attempt channel sequences. */
  nextOutbound: number;
  nextInbound: number;
  /** The newest parent entry whose session events were all relayed, and the parent's last relayed token count. */
  relayedEntry: number;
  relayedTokens: number;
  terminalRelayed: boolean;
  /** The harvested `StepResult` as JSON, once the executor recorded it; absent on records written before it existed. */
  result?: string;
  /**
   * Why the parent conversation could not be read back from storage. Recorded
   * before the Attempt's task is aborted, so the abort fails the Attempt with
   * it instead of ending it as canceled.
   */
  storageFailure?: string;
  /** Operator inputs whose queued receipt was sent and whose delivery receipt was not, oldest first. */
  queuedInputs?: QueuedInput[];
  /**
   * The unsupervised milliseconds the Attempt's runaway guards counted, as
   * the latest of them recorded; absent until a guard with a wall-clock
   * ceiling records them, and on records written before it existed.
   */
  unsupervisedMillis?: number;
};

export const ATTEMPT_RECORD_KIND = "usine.attempt";

export const AttemptRecordDoc = defineDocFamily<AttemptRecord, null>({
  kind: ATTEMPT_RECORD_KIND,
  version: 1,
  scope: "session",
  family: true,
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
  }),
});

/**
 * Operator supervision of one running Attempt (ADR 0018): whether the parent
 * is interrupted, the operator messages waiting to start its next turn, and
 * the sessions under a Hold by id, the parent's included. Retired with the task.
 */
export type Hold = {
  paused: boolean;
  guidance: string[];
  held: string[];
};

/** The turn a released parent resumes with when the operator sent no message of their own. */
export const RELEASE_GUIDANCE =
  "The operator released you without further guidance. Continue the task; if it is already done, give your final answer.";

export const HoldDoc = defineDoc<Hold>({
  kind: "usine.hold",
  version: 1,
  scope: "task",
  initial: () => ({ paused: false, guidance: [], held: [] }),
});
