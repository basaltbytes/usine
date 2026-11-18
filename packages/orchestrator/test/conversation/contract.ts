import { assert, describe, it } from "@effect/vitest";
import { InstanceScope, ProjectScope, GitHubUserId } from "@usine/core/access";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  HarnessSession,
  RoleName,
  RoleSession,
  SessionTokensUpdated,
  TextOutput,
  TokenCount,
} from "@usine/core/agent/session";
import {
  type Anchor,
  anchorOf,
  AnchorKind,
  AnchorReference,
  Conversation,
  ConversationId,
  ConversationTitle,
  cancelTurn,
  defaultFormat,
  EventSequence,
  failTurn,
  Interrupted,
  isQueued,
  MemberPost,
  MessageBody,
  MessageSequence,
  Reply,
  startTurn,
  succeedTurn,
  type Turn,
  PostedWithSession,
  TurnId,
  TurnMember,
} from "@usine/core/conversation";
import { OperatorLogin } from "@usine/core/operator";
import { ProjectId } from "@usine/core/project";
import { NodeServices } from "@effect/platform-node";
import { DateTime, Effect, Layer, Option, type Scope } from "effect";
import { ConversationStore, ReadMarker } from "../../src/conversation/store.ts";

export interface StoreFixture {
  /** Opens the same store in a fresh scope, preserving committed records. */
  readonly open: Layer.Layer<ConversationStore>;
}

export interface StoreAdapter {
  readonly name: string;
  /** Allocates isolated storage and removes it after the test. */
  readonly fixture: Effect.Effect<StoreFixture, never, Scope.Scope>;
}

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 17, 9, minute));
const member = TurnMember.make({ id: GitHubUserId.make(7), login: OperatorLogin.make("ada") });
const other = TurnMember.make({ id: GitHubUserId.make(8), login: OperatorLogin.make("grace") });
const session = RoleSession.make({
  id: AgentSessionId.make("conversation-1"),
  role: RoleName.make("supervisor"),
  agent: AgentName.make("supervisor"),
  brain: BrainSpec.make({
    harness: Harness.make("claude"),
    model: ModelId.make("claude-sonnet-5-5"),
    effort: "low",
  }),
});
const spent = (tokens: number) =>
  Option.some(SessionTokensUpdated.make({ session, totalTokens: TokenCount.make(tokens) }));
const text = (value: string) => TextOutput.make({ session, text: value });

const conversationOf = (id: string, minute: number, anchor = Option.none<Anchor>()) =>
  Conversation.make({
    id: ConversationId.make(id),
    title: ConversationTitle.make(`Conversation ${id}`),
    scope: ProjectScope.make({ project: ProjectId.make("factory") }),
    anchor,
    createdBy: member.login,
    createdAt: at(minute),
  });

const postTo = (
  conversation: Conversation,
  turn: string,
  minute: number,
  body: string,
  author = member,
) =>
  MemberPost.make({
    conversation: conversation.id,
    turn: TurnId.make(turn),
    member: author,
    credential: PostedWithSession.make({}),
    format: defaultFormat,
    body: MessageBody.make(body),
    reply: defaultFormat,
    at: at(minute),
  });

const queuedOf = (turn: Turn | undefined) =>
  turn !== undefined && isQueued(turn)
    ? Effect.succeed(turn)
    : Effect.die(new Error("Expected a queued turn"));

/** The behavior that every conversation store adapter must have. */
export const conversationStoreContract = (adapter: StoreAdapter) =>
  describe(`ConversationStore: ${adapter.name}`, () => {
    const withStore = <A, E>(
      use: (store: ConversationStore["Service"], fixture: StoreFixture) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        return yield* Effect.service(ConversationStore).pipe(
          Effect.flatMap((store) => use(store, fixture)),
          Effect.provide(fixture.open),
        );
      }).pipe(Effect.scoped);

    it.effect("creates a conversation and returns an anchor of an unknown kind unchanged", () =>
      withStore((store) =>
        Effect.gen(function* () {
          const anchor = yield* anchorOf(
            AnchorKind.make("map-pin/v9"),
            AnchorReference.make("tile 4:7 — « north ridge »"),
          );
          const conversation = conversationOf("c1", 1, Option.some(anchor));
          const created = yield* store.create(
            conversation,
            postTo(conversation, "t1", 1, "What needs me?"),
          );
          assert.strictEqual(created.messages[0]?.sequence, 1);
          assert.strictEqual(created.turns[0]?.state._tag, "Queued");
          const read = yield* store.get(conversation.id);
          assert.deepStrictEqual(read, Option.some(created));
          assert.deepStrictEqual(
            Option.map(read, ({ conversation }) => conversation.anchor),
            Option.some(Option.some(anchor)),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("appends member messages in order and refuses an unknown conversation", () =>
      withStore((store) =>
        Effect.gen(function* () {
          const conversation = conversationOf("c1", 1);
          yield* store.create(conversation, postTo(conversation, "t1", 1, "first"));
          const second = yield* store.post(postTo(conversation, "t2", 2, "second"));
          assert.strictEqual(second.message.sequence, 2);
          assert.strictEqual(second.turn.message, 2);
          const missing = yield* store
            .post(postTo(conversationOf("absent", 3), "t3", 3, "lost"))
            .pipe(Effect.flip);
          assert.strictEqual(missing._tag, "ConversationNotFound");
          const read = yield* store.get(conversation.id);
          assert.deepStrictEqual<Option.Option<ReadonlyArray<unknown>>>(
            Option.map(read, ({ messages }) => messages.map(({ body }) => body)),
            Option.some(["first", "second"]),
          );
        }),
      ),
    );

    it.effect("lists conversations by anchor key, newest first, with the latest turn", () =>
      withStore((store) =>
        Effect.gen(function* () {
          const anchor = yield* anchorOf(
            AnchorKind.make("walkthrough"),
            AnchorReference.make("pr-1#3"),
          );
          const other = yield* anchorOf(
            AnchorKind.make("walkthrough"),
            AnchorReference.make("pr-1#4"),
          );
          const older = conversationOf("c-older", 1, Option.some(anchor));
          const newer = conversationOf("c-newer", 2, Option.some(anchor));
          const elsewhere = conversationOf("c-other", 3, Option.some(other));
          const plain = conversationOf("c-plain", 4);
          for (const conversation of [older, newer, elsewhere, plain])
            yield* store.create(
              conversation,
              postTo(conversation, `t-${conversation.id}`, 1, "hi"),
            );
          const second = yield* store.post(postTo(plain, "t-plain-2", 2, "again"));
          const anchored = yield* store.list(Option.some(anchor.key), Option.none());
          assert.deepStrictEqual(
            anchored.map(({ conversation }) => conversation.id),
            [newer.id, older.id],
          );
          const all = yield* store.list(Option.none(), Option.none());
          assert.deepStrictEqual(
            all.map(({ conversation }) => conversation.id),
            [plain.id, elsewhere.id, newer.id, older.id],
          );
          assert.deepStrictEqual(
            Option.map(all[0]?.lastTurn ?? Option.none(), ({ id }) => id),
            Option.some(second.turn.id),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("changes turn states only from the stored state and stores the answer", () =>
      withStore((store) =>
        Effect.gen(function* () {
          const conversation = Conversation.make({
            ...conversationOf("c1", 1),
            scope: InstanceScope.make(),
          });
          const created = yield* store.create(conversation, postTo(conversation, "t1", 1, "first"));
          const second = yield* store.post(postTo(conversation, "t2", 2, "second"));
          const queued = yield* queuedOf(created.turns[0]);
          const running = startTurn(queued, at(3));
          yield* store.transition(queued, running);
          const stale = yield* store.transition(queued, startTurn(queued, at(4))).pipe(Effect.flip);
          assert.strictEqual(stale._tag, "TurnConflict");
          assert.deepStrictEqual(
            (yield* store.open).map(({ id, state }) => [id, state._tag]),
            [
              [running.id, "Running"],
              [second.turn.id, "Queued"],
            ],
          );
          const saved = HarnessSession.make({ cwd: "/conversation" });
          const answer = yield* store.answer(
            running,
            succeedTurn(running, at(5), saved, spent(120)),
            Reply.make({ body: MessageBody.make("Nothing needs you."), at: at(5) }),
          );
          assert.strictEqual(answer.sequence, 3);
          assert.strictEqual(answer.turn, running.id);
          const repeated = yield* store
            .answer(
              running,
              succeedTurn(running, at(6), saved, spent(130)),
              Reply.make({ body: MessageBody.make("Twice"), at: at(6) }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(repeated._tag, "TurnConflict");
          const nextQueued = yield* queuedOf(second.turn);
          yield* store.transition(
            nextQueued,
            cancelTurn(nextQueued, at(7), member.login, spent(120)),
          );
          const read = yield* store.get(conversation.id);
          assert.deepStrictEqual<Option.Option<unknown>>(
            Option.map(read, ({ turns, messages }) => ({
              turns: turns.map(({ state }) => state._tag),
              messages: messages.map(({ role, body }) => [role, body]),
            })),
            Option.some({
              turns: ["Succeeded", "Canceled"],
              messages: [
                ["member", "first"],
                ["member", "second"],
                ["supervisor", "Nothing needs you."],
              ],
            }),
          );
          const remaining = yield* store.open;
          assert.deepStrictEqual(remaining, []);
        }),
      ),
    );

    it.effect("numbers events across turns and tails them by sequence", () =>
      withStore((store) =>
        Effect.gen(function* () {
          const conversation = conversationOf("c1", 1);
          const created = yield* store.create(conversation, postTo(conversation, "t1", 1, "first"));
          const second = yield* store.post(postTo(conversation, "t2", 2, "second"));
          const firstTurn = yield* queuedOf(created.turns[0]);
          const first = yield* store.append(firstTurn, [text("one"), text("two")]);
          const later = yield* store.append(second.turn, [text("three")]);
          assert.deepStrictEqual(
            [...first, ...later].map(({ sequence, turn }) => [sequence, turn]),
            [
              [1, firstTurn.id],
              [2, firstTurn.id],
              [3, second.turn.id],
            ],
          );
          const tail = yield* store.events(conversation.id, EventSequence.make(1), 10);
          assert.deepStrictEqual(
            tail.map(({ event }) => (event._tag === "TextOutput" ? event.text : event._tag)),
            ["two", "three"],
          );
          assert.deepStrictEqual(
            (yield* store.events(conversation.id, 0, 1)).map(({ sequence }) => sequence),
            [1],
          );
          const none = yield* store.events(conversation.id, EventSequence.make(3), 10);
          assert.deepStrictEqual(none, []);
        }),
      ),
    );

    it.effect(
      "lists a conversation unread only for activity by someone else after the marker",
      () =>
        withStore((store, fixture) =>
          Effect.gen(function* () {
            const conversation = conversationOf("c1", 1);
            const created = yield* store.create(
              conversation,
              postTo(conversation, "t1", 1, "first"),
            );
            const expectUnread = (reader: TurnMember, expected: boolean) =>
              Effect.gen(function* () {
                const all = yield* store.list(Option.none(), Option.some(reader.id));
                assert.deepStrictEqual(
                  all.map(({ unread }) => unread),
                  [Option.some(expected)],
                  reader.login,
                );
              });
            const marker = (reader: TurnMember, through: number, minute: number) =>
              ReadMarker.make({
                conversation: conversation.id,
                member: reader.id,
                through: MessageSequence.make(through),
                at: at(minute),
              });
            yield* expectUnread(member, false);
            yield* expectUnread(other, true);
            const unlisted = yield* store.list(Option.none(), Option.none());
            assert.deepStrictEqual(
              unlisted.map(({ unread }) => unread),
              [Option.none()],
            );
            assert.deepStrictEqual(
              unlisted.map(({ lastMessage }) => Option.map(lastMessage, ({ body }) => body)),
              [Option.some(MessageBody.make("first"))],
            );
            yield* store.markRead(marker(other, 1, 2));
            yield* expectUnread(other, false);
            const queued = yield* queuedOf(created.turns[0]);
            const running = startTurn(queued, at(3));
            yield* store.transition(queued, running);
            yield* store.answer(
              running,
              succeedTurn(running, at(4), HarnessSession.make({ cwd: "/conversation" }), spent(10)),
              Reply.make({ body: MessageBody.make("Nothing."), at: at(4) }),
            );
            yield* expectUnread(member, true);
            yield* store.markRead(marker(member, 2, 5));
            const back = yield* store.markRead(marker(member, 1, 6));
            assert.strictEqual(back.through, 2);
            yield* expectUnread(member, false);
            const second = yield* store.post(postTo(conversation, "t2", 7, "again", other));
            yield* expectUnread(member, true);
            yield* expectUnread(other, true);
            yield* store.markRead(marker(member, 3, 8));
            yield* store.markRead(marker(other, 3, 8));
            yield* expectUnread(other, false);
            const queuedAgain = yield* queuedOf(second.turn);
            const runningAgain = startTurn(queuedAgain, at(9));
            yield* store.transition(queuedAgain, runningAgain);
            yield* store.transition(
              runningAgain,
              failTurn(runningAgain, at(10), Interrupted.make({}), Option.none()),
            );
            const reopened = yield* Effect.gen(function* () {
              const store = yield* Effect.service(ConversationStore);
              return yield* store.list(Option.none(), Option.some(member.id));
            }).pipe(Effect.provide(fixture.open));
            assert.deepStrictEqual(
              reopened.map(({ unread }) => unread),
              [Option.some(true)],
            );
            yield* store.markRead(marker(member, 3, 11));
            yield* expectUnread(member, false);
            const missing = yield* store
              .markRead(
                ReadMarker.make({
                  ...marker(member, 1, 12),
                  conversation: ConversationId.make("absent"),
                }),
              )
              .pipe(Effect.flip);
            assert.strictEqual(missing._tag, "ConversationNotFound");
          }),
        ),
    );

    it.effect("keeps a failed turn's interrupted marker after the store reopens", () =>
      withStore((store, fixture) =>
        Effect.gen(function* () {
          const conversation = conversationOf("c1", 1);
          const created = yield* store.create(conversation, postTo(conversation, "t1", 1, "first"));
          const queued = yield* queuedOf(created.turns[0]);
          const running = startTurn(queued, at(2));
          yield* store.transition(queued, running);
          yield* store.append(running, [text("partial")]);
          yield* store.transition(
            running,
            failTurn(running, at(3), Interrupted.make({}), spent(40)),
          );
          const { read, events } = yield* Effect.gen(function* () {
            const reopened = yield* Effect.service(ConversationStore);
            return {
              read: yield* reopened.get(conversation.id),
              events: yield* reopened.events(conversation.id, 0, 10),
            };
          }).pipe(Effect.provide(fixture.open));
          const state = Option.flatMap(read, ({ turns }) =>
            Option.fromUndefinedOr(turns[0]?.state),
          );
          assert.deepStrictEqual(
            Option.map(state, (value) =>
              value._tag === "Failed" ? [value.failure._tag, value.usage] : [value._tag],
            ),
            Option.some(["Interrupted", spent(40)]),
          );
          assert.strictEqual(events.length, 1);
        }),
      ),
    );
  });
