import {
  type Conversation,
  type ConversationId,
  EventSequence,
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
  Posted,
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
      list: Effect.fn("ConversationStore.list")(function* (key) {
        const all = [...(yield* Ref.get(state)).values()].map(({ conversation }) => conversation);
        return all
          .filter((conversation) =>
            Option.match(key, {
              onNone: () => true,
              onSome: (wanted) =>
                Option.exists(conversation.anchor, (anchor) => anchor.key === wanted),
            }),
          )
          .sort(
            (left, right) =>
              DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt) ||
              right.id.localeCompare(left.id),
          );
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
