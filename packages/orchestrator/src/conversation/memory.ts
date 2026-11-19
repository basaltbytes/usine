import type { GitHubUserId } from "@usine/core/access";
import {
  type Conversation,
  type ConversationId,
  EventSequence,
  followedUp,
  followUpOf,
  isOpen,
  type Message,
  MessageSequence,
  numbered,
  posted,
  replied,
  type Turn,
  type TurnEvent,
} from "@usine/core/conversation";
import { DateTime, Effect, Layer, Option, Ref, Semaphore } from "effect";
import {
  ConversationNotFound,
  ConversationRecord,
  ConversationStore,
  ConversationSummary,
  isUnread,
  Posted,
  type ReadMarker,
  TurnConflict,
} from "./store.ts";

interface Stored {
  readonly conversation: Conversation;
  readonly messages: ReadonlyArray<Message>;
  readonly turns: ReadonlyArray<Turn>;
  readonly events: ReadonlyArray<TurnEvent>;
}

const nextMessage = (stored: Stored) => MessageSequence.make(stored.messages.length + 1);

/**
 * Provides an empty conversation store in memory. Each layer build has its own state, and writes
 * apply one at a time.
 */
export const memoryConversationStoreLayer = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map<ConversationId, Stored>());
    const reads = yield* Ref.make(new Map<string, ReadMarker>());
    const readKey = (conversation: ConversationId, member: GitHubUserId) =>
      `${conversation}:${member}`;
    const lock = yield* Semaphore.make(1);
    const serialized = lock.withPermits(1);
    const save = (stored: Stored) =>
      Ref.update(state, (all) => new Map(all).set(stored.conversation.id, stored));
    const load = (id: ConversationId) =>
      Ref.get(state).pipe(Effect.map((all) => Option.fromUndefinedOr(all.get(id))));
    const record = ({ conversation, messages, turns }: Stored) =>
      ConversationRecord.make({ conversation, messages, turns });
    const replace = (from: Turn, to: Turn) =>
      Effect.gen(function* () {
        const stored = yield* load(from.conversation);
        const current = Option.flatMap(stored, ({ turns }) =>
          Option.fromUndefinedOr(turns.find(({ id }) => id === from.id)),
        );
        if (
          Option.isNone(stored) ||
          Option.isNone(current) ||
          current.value.state._tag !== from.state._tag
        )
          return yield* TurnConflict.make({ turn: from.id, expected: from.state._tag });
        return {
          ...stored.value,
          turns: stored.value.turns.map((turn) => (turn.id === to.id ? to : turn)),
        };
      });

    return ConversationStore.of({
      create: Effect.fn("ConversationStore.create")(function* (conversation, post) {
        yield* Effect.annotateCurrentSpan({ conversation: conversation.id });
        return yield* Effect.gen(function* () {
          const { message, turn } = posted(post, MessageSequence.make(1));
          const stored = { conversation, messages: [message], turns: [turn], events: [] };
          yield* save(stored);
          return record(stored);
        }).pipe(serialized);
      }),
      followUp: Effect.fn("ConversationStore.followUp")(function* (post) {
        yield* Effect.annotateCurrentSpan({
          conversation: post.conversation,
          reports: post.reports,
        });
        return yield* Effect.gen(function* () {
          const stored = yield* load(post.conversation);
          if (Option.isNone(stored))
            return yield* ConversationNotFound.make({ conversation: post.conversation });
          const id = followUpOf(post.reports);
          if (stored.value.turns.some((turn) => turn.id === id)) return Option.none<Turn>();
          const { message, turn } = followedUp(post, nextMessage(stored.value));
          yield* save({
            ...stored.value,
            messages: [...stored.value.messages, message],
            turns: [...stored.value.turns, turn],
          });
          return Option.some<Turn>(turn);
        }).pipe(serialized);
      }),
      post: Effect.fn("ConversationStore.post")(function* (post) {
        yield* Effect.annotateCurrentSpan({ conversation: post.conversation });
        return yield* Effect.gen(function* () {
          const stored = yield* load(post.conversation);
          if (Option.isNone(stored))
            return yield* ConversationNotFound.make({ conversation: post.conversation });
          const { message, turn } = posted(post, nextMessage(stored.value));
          yield* save({
            ...stored.value,
            messages: [...stored.value.messages, message],
            turns: [...stored.value.turns, turn],
          });
          return Posted.make({ message, turn });
        }).pipe(serialized);
      }),
      get: Effect.fn("ConversationStore.get")(function* (id) {
        const stored = yield* load(id);
        return Option.map(stored, record);
      }),
      list: Effect.fn("ConversationStore.list")(function* (key, reader) {
        const all = [...(yield* Ref.get(state)).values()];
        const markers = yield* Ref.get(reads);
        return all
          .filter(({ conversation }) =>
            Option.match(key, {
              onNone: () => true,
              onSome: (wanted) =>
                Option.exists(conversation.anchor, (anchor) => anchor.key === wanted),
            }),
          )
          .sort(
            (left, right) =>
              DateTime.toEpochMillis(right.conversation.createdAt) -
                DateTime.toEpochMillis(left.conversation.createdAt) ||
              right.conversation.id.localeCompare(left.conversation.id),
          )
          .map(({ conversation, messages, turns }) =>
            ConversationSummary.make({
              conversation,
              lastTurn: Option.fromUndefinedOr(turns.at(-1)),
              lastMessage: Option.fromUndefinedOr(messages.at(-1)),
              unread: Option.map(reader, (member) =>
                isUnread(
                  member,
                  messages,
                  turns,
                  Option.fromUndefinedOr(markers.get(readKey(conversation.id, member))),
                ),
              ),
            }),
          );
      }),
      markRead: Effect.fn("ConversationStore.markRead")(function* (marker) {
        yield* Effect.annotateCurrentSpan({ conversation: marker.conversation });
        return yield* Effect.gen(function* () {
          const stored = yield* load(marker.conversation);
          if (Option.isNone(stored))
            return yield* ConversationNotFound.make({ conversation: marker.conversation });
          const key = readKey(marker.conversation, marker.member);
          const current = (yield* Ref.get(reads)).get(key);
          if (current !== undefined && current.through > marker.through) return current;
          yield* Ref.update(reads, (all) => new Map(all).set(key, marker));
          return marker;
        }).pipe(serialized);
      }),
      transition: Effect.fn("ConversationStore.transition")(function* (from, to) {
        yield* Effect.annotateCurrentSpan({ turn: from.id, from: from.state._tag });
        yield* replace(from, to).pipe(Effect.flatMap(save), serialized);
      }),
      answer: Effect.fn("ConversationStore.answer")(function* (from, to, reply) {
        yield* Effect.annotateCurrentSpan({ turn: from.id });
        return yield* Effect.gen(function* () {
          const stored = yield* replace(from, to);
          const message = replied(to, reply, nextMessage(stored));
          yield* save({ ...stored, messages: [...stored.messages, message] });
          return message;
        }).pipe(serialized);
      }),
      append: Effect.fn("ConversationStore.append")(function* (turn, events) {
        yield* Effect.annotateCurrentSpan({ turn: turn.id, events: events.length });
        return yield* Effect.gen(function* () {
          const stored = yield* load(turn.conversation);
          if (Option.isNone(stored))
            return yield* Effect.die(new Error(`Conversation ${turn.conversation} is not stored`));
          const added = numbered(turn, events, EventSequence.make(stored.value.events.length + 1));
          yield* save({ ...stored.value, events: [...stored.value.events, ...added] });
          return added;
        }).pipe(serialized);
      }),
      events: Effect.fn("ConversationStore.events")(function* (conversation, after, limit) {
        const stored = yield* load(conversation);
        return Option.match(stored, {
          onNone: () => [],
          onSome: ({ events }) => events.filter(({ sequence }) => sequence > after).slice(0, limit),
        });
      }),
      open: Ref.get(state).pipe(
        Effect.map((all) =>
          [...all.values()]
            .flatMap(({ turns }) => turns.filter(isOpen))
            .sort(
              (left, right) =>
                DateTime.toEpochMillis(left.queuedAt) - DateTime.toEpochMillis(right.queuedAt),
            ),
        ),
        Effect.withSpan("ConversationStore.open"),
      ),
    });
  }),
);
