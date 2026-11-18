import {
  defaultFormat,
  MemberMessage,
  MessageBody,
  MessageSequence,
  Queued,
  type SupervisorMessage,
  type TurnEvent,
  TurnId,
  type TurnMember,
} from "@usine/core/conversation";
import type { ConversationView, TurnView } from "@usine/orchestrator/operator/http";
import { type DateTime, Option, Schema } from "effect";
import type { ToolCall } from "~/lib/runs/transcript/model";

export type Conversation = typeof ConversationView.Type;
export type Turn = typeof TurnView.Type;

type TextStep = { readonly _tag: "Text"; readonly key: string; readonly text: string };

/** One step of a turn's activity, in the order the session reported it. */
type Activity = TextStep | { readonly _tag: "Tool"; readonly call: ToolCall };

/** The tool calls of a turn between two texts, shown as one line. */
export interface ToolGroupStep {
  readonly _tag: "Tools";
  /** The key of its first call, so it stays the same as calls are added. */
  readonly key: string;
  readonly calls: readonly [ToolCall, ...ToolCall[]];
}

/** A text of a turn, or the tool calls between two texts. */
export type TurnStep = TextStep | ToolGroupStep;

/** A member message, what its turn did, and the supervisor's answer once there is one. */
export interface TurnEntry {
  readonly turn: Turn;
  readonly message: MemberMessage | undefined;
  readonly activity: ReadonlyArray<TurnStep>;
  readonly reply: SupervisorMessage | undefined;
  /** Whether an earlier turn of the conversation is queued or running. */
  readonly behind: boolean;
}

const open = (turn: Turn) => turn.state._tag === "Queued" || turn.state._tag === "Running";

const isMember = (message: Conversation["messages"][number]): message is MemberMessage =>
  message.role === "member";
const isSupervisor = (message: Conversation["messages"][number]): message is SupervisorMessage =>
  message.role === "supervisor";

/** Returns the session events of `turn` as text and tool calls, each tool call paired by `callId`. */
const turnActivity = (turn: Turn, events: ReadonlyArray<TurnEvent>): ReadonlyArray<Activity> => {
  const activity: Array<Activity> = [];
  const calls = new Map<string, number>();
  for (const { sequence, event } of events) {
    if (event._tag === "TextOutput")
      activity.push({ _tag: "Text", key: `${turn.id}:${sequence}`, text: event.text });
    else if (event._tag === "ToolStarted") {
      calls.set(event.callId, activity.length);
      activity.push({
        _tag: "Tool",
        call: {
          key: `${turn.id}:${event.callId}`,
          name: event.tool,
          start: Option.some({ input: event.input }),
          state: { _tag: turn.state._tag === "Running" ? "Running" : "Stopped" },
        },
      });
    } else if (event._tag === "ToolFinished") {
      const index = calls.get(event.callId);
      const started = index === undefined ? undefined : activity[index];
      const state = {
        _tag: event.isError ? ("Error" as const) : ("Finished" as const),
        output: event.output,
      };
      if (started?._tag === "Tool" && index !== undefined)
        activity[index] = { _tag: "Tool", call: { ...started.call, state } };
      else
        activity.push({
          _tag: "Tool",
          call: {
            key: `${turn.id}:${event.callId}`,
            name: event.tool,
            start: Option.none(),
            state,
          },
        });
    }
  }
  return activity;
};

/** Returns `activity` with each run of consecutive tool calls as one group. */
const groupCalls = (activity: ReadonlyArray<Activity>): ReadonlyArray<TurnStep> => {
  const steps: Array<TurnStep> = [];
  for (const step of activity) {
    if (step._tag === "Text") {
      steps.push(step);
      continue;
    }
    const last = steps.at(-1);
    if (last?._tag === "Tools")
      steps[steps.length - 1] = { ...last, calls: [...last.calls, step.call] };
    else steps.push({ _tag: "Tools", key: `tools:${step.call.key}`, calls: [step.call] });
  }
  return steps;
};

/**
 * Returns the conversation as turns in message order: each with its member message, its activity
 * as texts and groups of tool calls, and its answer. A text that repeats the answer is left out,
 * so the answer shows once.
 */
export const conversationTimeline = (
  conversation: Conversation,
  events: ReadonlyArray<TurnEvent>,
): ReadonlyArray<TurnEntry> => {
  const turns = [...conversation.turns].sort((left, right) => left.message - right.message);
  return turns.map((turn, index) => {
    const reply = conversation.messages
      .filter(isSupervisor)
      .find((entry) => entry.turn === turn.id);
    const answer = reply === undefined ? undefined : bodyText(reply.body).trim();
    const activity = groupCalls(
      turnActivity(
        turn,
        events.filter((entry) => entry.turn === turn.id),
      ).filter((step) => step._tag !== "Text" || step.text.trim() !== answer),
    );
    return {
      turn,
      message: conversation.messages
        .filter(isMember)
        .find(({ sequence }) => sequence === turn.message),
      activity,
      reply,
      behind: turns.slice(0, index).some(open),
    };
  });
};

const isText = Schema.is(Schema.String);

/** Returns the text of a message body: a string as it is, any other value as indented JSON. */
export const bodyText = (body: MemberMessage["body"]): string =>
  isText(body) ? body : JSON.stringify(body, null, 2);

/** Returns the Markdown of a message whose body is Markdown text, or `undefined` otherwise. */
export const markdownBody = (message: MemberMessage | SupervisorMessage): string | undefined =>
  message.format === "markdown" && isText(message.body) ? message.body : undefined;

const PENDING = "pending:";

/** Returns whether `turn` is the placeholder of a message that is still being sent. */
export const isPending = (turn: Turn): boolean => turn.id.startsWith(PENDING);

/** Returns `conversation` with `text` appended as a sent message whose turn is queued. */
export const withPendingPost = (
  conversation: Conversation,
  text: string,
  member: TurnMember,
  at: DateTime.Utc,
): Conversation => {
  const sequence = MessageSequence.make(
    Math.max(0, ...conversation.messages.map((message) => message.sequence)) + 1,
  );
  const turn = TurnId.make(`${PENDING}${sequence}`);
  const id = conversation.conversation.id;
  return {
    ...conversation,
    messages: [
      ...conversation.messages,
      MemberMessage.make({
        conversation: id,
        sequence,
        turn,
        format: defaultFormat,
        body: MessageBody.make(text),
        createdAt: at,
        role: "member",
        author: member.login,
      }),
    ],
    turns: [
      ...conversation.turns,
      {
        id: turn,
        conversation: id,
        member,
        message: sequence,
        reply: defaultFormat,
        queuedAt: at,
        state: Queued.make({}),
      },
    ],
  };
};
