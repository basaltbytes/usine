import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
  type TaskId,
} from "@earendil-works/pi-durable";

/** What a completed `usine.attempt` task returns: the parent's final message. */
export type AttemptResult = { message: string };

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
  /** The first blocked child report; it fails the Attempt unless the parent relays a blocker itself. */
  childBlocker: { sessionId: string; message: string } | null;
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
 * is interrupted, the operator messages waiting to resume it, and the children
 * under a Hold. Retired with the task.
 */
export type Hold = {
  paused: boolean;
  guidance: string[];
  held: string[];
};

export const HoldDoc = defineDoc<Hold>({
  kind: "usine.hold",
  version: 1,
  scope: "task",
  initial: () => ({ paused: false, guidance: [], held: [] }),
});
