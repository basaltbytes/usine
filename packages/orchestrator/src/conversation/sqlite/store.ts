import {
  Conversation,
  type ConversationId,
  EventSequence,
  isOpen,
  Message,
  MessageSequence,
  numbered,
  posted,
  replied,
  Turn,
  TurnEvent,
} from "@usine/core/conversation";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import {
  ConversationNotFound,
  ConversationRecord,
  ConversationStore,
  ConversationStoreError,
  ConversationSummary,
  Posted,
  TurnConflict,
} from "../store.ts";

const json = <S extends Schema.Top>(schema: S) => Schema.fromJsonString(Schema.toCodecJson(schema));

const ConversationJson = json(Conversation);
const MessageJson = json(Message);
const TurnJson = json(Turn);
const EventJson = json(TurnEvent);

const LastRow = Schema.Struct({ last: Schema.NullOr(Schema.Int) });

// Every value written was validated at construction, so an encoding failure is a defect.
const encode =
  <T>(codec: Schema.Codec<T, string>) =>
  (value: T) =>
    Schema.encodeEffect(codec)(value).pipe(Effect.orDie);

const decodeValues = <T>(codec: Schema.Codec<T, string>) => {
  const decode = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: codec })));
  return (rows: ReadonlyArray<unknown>) =>
    decode(rows).pipe(Effect.map((decoded) => decoded.map(({ value }) => value)));
};

const decodeSummaries = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ value: ConversationJson, lastTurn: Schema.NullOr(TurnJson) })),
);

/**
 * Provides the conversation store on the application's `SqlClient`. Applies its migrations with
 * their own `usine_conversation_migrations` ledger, and runs each write in one `BEGIN IMMEDIATE`
 * transaction. Rows hold Schema-encoded JSON values; the other columns index them.
 */
export const sqliteConversationStoreLayer = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrator.make({})({
      table: "usine_conversation_migrations",
      loader: Migrator.fromRecord({
        "0001_conversations": Effect.gen(function* () {
          yield* sql`CREATE TABLE usine_conversations (id TEXT PRIMARY KEY, anchor_key TEXT, created_at INTEGER NOT NULL, value TEXT NOT NULL)`;
          yield* sql`CREATE INDEX usine_conversations_anchor ON usine_conversations (anchor_key)`;
          yield* sql`CREATE TABLE usine_conversation_messages (conversation_id TEXT NOT NULL REFERENCES usine_conversations (id), sequence INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (conversation_id, sequence))`;
          yield* sql`CREATE TABLE usine_conversation_turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES usine_conversations (id), message_sequence INTEGER NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL)`;
          yield* sql`CREATE INDEX usine_conversation_turns_conversation ON usine_conversation_turns (conversation_id, message_sequence)`;
          yield* sql`CREATE INDEX usine_conversation_turns_state ON usine_conversation_turns (state)`;
          yield* sql`CREATE TABLE usine_conversation_turn_events (conversation_id TEXT NOT NULL REFERENCES usine_conversations (id), sequence INTEGER NOT NULL, turn_id TEXT NOT NULL REFERENCES usine_conversation_turns (id), value TEXT NOT NULL, PRIMARY KEY (conversation_id, sequence))`;
        }),
      }),
    }).pipe(Effect.orDie);

    const failure = (operation: string) => (cause: unknown) =>
      Effect.fail(ConversationStoreError.make({ operation, cause }));
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        sql.withTransaction,
        Effect.provideService(SqlClient.BeginTransaction, "BEGIN IMMEDIATE"),
      );

    const nextMessage = (conversation: ConversationId) =>
      sql`SELECT max(sequence) AS last FROM usine_conversation_messages WHERE conversation_id = ${conversation}`.pipe(
        Effect.flatMap(([row]) => Schema.decodeUnknownEffect(LastRow)(row)),
        Effect.map(({ last }) => MessageSequence.make((last ?? 0) + 1)),
      );
    const insertMessage = (message: Message) =>
      Effect.gen(function* () {
        const value = yield* encode(MessageJson)(message);
        yield* sql`INSERT INTO usine_conversation_messages ${sql.insert({ conversation_id: message.conversation, sequence: message.sequence, value })}`;
      });
    const insertTurn = (turn: Turn) =>
      Effect.gen(function* () {
        const value = yield* encode(TurnJson)(turn);
        yield* sql`INSERT INTO usine_conversation_turns ${sql.insert({ id: turn.id, conversation_id: turn.conversation, message_sequence: turn.message, state: turn.state._tag, value })}`;
      });
    const replaceTurn = (from: Turn, to: Turn) =>
      Effect.gen(function* () {
        const value = yield* encode(TurnJson)(to);
        const updated =
          yield* sql`UPDATE usine_conversation_turns SET ${sql.update({ state: to.state._tag, value })} WHERE id = ${from.id} AND state = ${from.state._tag} RETURNING id`;
        if (updated.length === 0)
          return yield* TurnConflict.make({ turn: from.id, expected: from.state._tag });
      });
    const load = (id: ConversationId) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT value FROM usine_conversations WHERE id = ${id}`;
        const [conversation] = yield* decodeValues(ConversationJson)(rows);
        if (conversation === undefined) return Option.none<ConversationRecord>();
        const messages =
          yield* sql`SELECT value FROM usine_conversation_messages WHERE conversation_id = ${id} ORDER BY sequence`.pipe(
            Effect.flatMap(decodeValues(MessageJson)),
          );
        const turns =
          yield* sql`SELECT value FROM usine_conversation_turns WHERE conversation_id = ${id} ORDER BY message_sequence`.pipe(
            Effect.flatMap(decodeValues(TurnJson)),
          );
        return Option.some(ConversationRecord.make({ conversation, messages, turns }));
      });

    return ConversationStore.of({
      create: Effect.fn("ConversationStore.create")(function* (conversation, post) {
        yield* Effect.annotateCurrentSpan({ conversation: conversation.id });
        return yield* Effect.gen(function* () {
          const value = yield* encode(ConversationJson)(conversation);
          yield* sql`INSERT INTO usine_conversations ${sql.insert({
            id: conversation.id,
            anchor_key: Option.match(conversation.anchor, {
              onNone: () => null,
              onSome: ({ key }) => key,
            }),
            created_at: DateTime.toEpochMillis(conversation.createdAt),
            value,
          })}`;
          const { message, turn } = posted(post, MessageSequence.make(1));
          yield* insertMessage(message);
          yield* insertTurn(turn);
          return ConversationRecord.make({ conversation, messages: [message], turns: [turn] });
        }).pipe(transaction, Effect.catchTag("SqlError", failure("create a conversation")));
      }),
      post: Effect.fn("ConversationStore.post")(function* (post) {
        yield* Effect.annotateCurrentSpan({ conversation: post.conversation });
        return yield* Effect.gen(function* () {
          const [exists] =
            yield* sql`SELECT id FROM usine_conversations WHERE id = ${post.conversation}`;
          if (exists === undefined)
            return yield* ConversationNotFound.make({ conversation: post.conversation });
          const sequence = yield* nextMessage(post.conversation);
          const { message, turn } = posted(post, sequence);
          yield* insertMessage(message);
          yield* insertTurn(turn);
          return Posted.make({ message, turn });
        }).pipe(
          transaction,
          Effect.catchTag(["SqlError", "SchemaError"], failure("post a message")),
        );
      }),
      get: Effect.fn("ConversationStore.get")(function* (id) {
        yield* Effect.annotateCurrentSpan({ conversation: id });
        // One transaction, so the three reads can't straddle a commit.
        return yield* load(id).pipe(
          sql.withTransaction,
          Effect.catchTag(["SqlError", "SchemaError"], failure("read a conversation")),
        );
      }),
      list: Effect.fn("ConversationStore.list")(function* (key) {
        const lastTurn = sql`(SELECT t.value FROM usine_conversation_turns t WHERE t.conversation_id = c.id ORDER BY t.message_sequence DESC LIMIT 1)`;
        const rows = yield* Option.match(key, {
          onNone: () =>
            sql`SELECT c.value AS value, ${lastTurn} AS "lastTurn" FROM usine_conversations c ORDER BY c.created_at DESC, c.id DESC`,
          onSome: (anchor) =>
            sql`SELECT c.value AS value, ${lastTurn} AS "lastTurn" FROM usine_conversations c WHERE c.anchor_key = ${anchor} ORDER BY c.created_at DESC, c.id DESC`,
        }).pipe(Effect.catchTag("SqlError", failure("list conversations")));
        const decoded = yield* decodeSummaries(rows).pipe(
          Effect.catchTag("SchemaError", failure("list conversations")),
        );
        return decoded.map(({ value, lastTurn: turn }) =>
          ConversationSummary.make({ conversation: value, lastTurn: Option.fromNullOr(turn) }),
        );
      }),
      transition: Effect.fn("ConversationStore.transition")(function* (from, to) {
        yield* Effect.annotateCurrentSpan({ turn: from.id, from: from.state._tag });
        yield* replaceTurn(from, to).pipe(
          transaction,
          Effect.catchTag("SqlError", failure("change a turn's state")),
        );
      }),
      answer: Effect.fn("ConversationStore.answer")(function* (from, to, reply) {
        yield* Effect.annotateCurrentSpan({ turn: from.id });
        return yield* Effect.gen(function* () {
          yield* replaceTurn(from, to);
          const sequence = yield* nextMessage(to.conversation);
          const message = replied(to, reply, sequence);
          yield* insertMessage(message);
          return message;
        }).pipe(
          transaction,
          Effect.catchTag(["SqlError", "SchemaError"], failure("store a turn's answer")),
        );
      }),
      append: Effect.fn("ConversationStore.append")(function* (turn, events) {
        yield* Effect.annotateCurrentSpan({ turn: turn.id, events: events.length });
        return yield* Effect.gen(function* () {
          const { last } =
            yield* sql`SELECT max(sequence) AS last FROM usine_conversation_turn_events WHERE conversation_id = ${turn.conversation}`.pipe(
              Effect.flatMap(([row]) => Schema.decodeUnknownEffect(LastRow)(row)),
            );
          const added = numbered(turn, events, EventSequence.make((last ?? 0) + 1));
          for (const event of added) {
            const value = yield* encode(EventJson)(event);
            yield* sql`INSERT INTO usine_conversation_turn_events ${sql.insert({ conversation_id: event.conversation, sequence: event.sequence, turn_id: event.turn, value })}`;
          }
          return added;
        }).pipe(
          transaction,
          Effect.catchTag(["SqlError", "SchemaError"], failure("append turn events")),
        );
      }),
      events: Effect.fn("ConversationStore.events")(function* (conversation, after, limit) {
        yield* Effect.annotateCurrentSpan({ conversation, after, limit });
        return yield* sql`SELECT value FROM usine_conversation_turn_events WHERE conversation_id = ${conversation} AND sequence > ${after} ORDER BY sequence LIMIT ${limit}`.pipe(
          Effect.flatMap(decodeValues(EventJson)),
          Effect.catchTag(["SqlError", "SchemaError"], failure("read turn events")),
        );
      }),
      open: sql`SELECT value FROM usine_conversation_turns WHERE state IN ('Queued', 'Running')`.pipe(
        Effect.flatMap(decodeValues(TurnJson)),
        Effect.map((turns) =>
          turns
            .filter(isOpen)
            .sort(
              (left, right) =>
                DateTime.toEpochMillis(left.queuedAt) - DateTime.toEpochMillis(right.queuedAt),
            ),
        ),
        Effect.catchTag(["SqlError", "SchemaError"], failure("read open turns")),
        Effect.withSpan("ConversationStore.open"),
      ),
    });
  }),
);
