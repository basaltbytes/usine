import type { TurnFailure, TurnState } from "@usine/core/conversation";

/** Returns a turn's state as the list shows it. */
export const turnStateLabel = (state: TurnState): string =>
  state._tag === "Succeeded" ? "Answered" : state._tag;

export const conversationsTitle = "Conversations";
export const newConversationLabel = "New conversation";
export const openConversationsLabel = "Ask the supervisor";
export const allConversationsLabel = "All conversations";
export const recentConversationsLabel = "Recent conversations";
export const conversationPanelLabel = "Conversation with the supervisor";
export const loadingConversation = "Loading conversation…";
export const conversationMissing = "Conversation not found";
export const conversationMissingDetail =
  "It was deleted, or your role bindings don't include its project.";

export const supervisorSpeaker = "Supervisor";
export const instanceScope = "Instance";

export const setupRequiredTitle = "Supervisor not set up";
export const notReadyTitle = "Message not sent";

export const readOnlyNote = (scope: string) =>
  `Read only. Posting needs operate access on ${scope}`;
export const signInToPost = "Read only. Posting needs a member sign-in";
export const noScopeToPost = "Read only. Posting needs operate access on a project";
export const readOnlyNotice =
  "Answers come from read-only access to runs, tasks, and the source. Nothing is changed.";

export const scopeLabel = "Scope";
export const messageLabel = "Message";
export const messagePlaceholder = "Ask about runs, tasks, or the source";
export const composerHint = "Enter to send, Shift+Enter for a new line";
export const sendLabel = "Send";
export const sendingLabel = "Sending…";
export const cancelTurnLabel = "Cancel turn";
export const cancelingTurnLabel = "Canceling…";

export const queuedLabel = "Queued";
export const queuedBehindLabel = "Queued after the turn before it";
export const runningLabel = "Running";
export const canceledLabel = (by: string) => `Canceled by ${by}`;
export const failedLabel = "Failed";
export const failureReason = (failure: TurnFailure) =>
  failure._tag === "Interrupted" ? "The orchestrator restarted during the turn" : failure.message;
export const unsentLabel = "Not sent";

export const emptyListTitle = "No conversations";
export const emptyListDescription =
  "A conversation asks the supervisor about runs, tasks, and the source, in the instance or one project. Answers come from read-only access.";
export const emptyConversation = "No messages yet";

export const startedByColumn = "Started by";
export const startedColumn = "Started";
export const lastTurnColumn = "Last turn";
export const conversationColumn = "Conversation";
export const noTurn = "No turn";

export const conversationCount = (count: number) =>
  count === 1 ? "1 conversation" : `${count} conversations`;
