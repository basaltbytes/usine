import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { HarnessSession, HarnessSessionId } from "@usine/core/agent/session";
import { OperatorMessage, type OperatorMessageId } from "@usine/core/attempt/channel";
import { Cause, Deferred, Effect, Fiber, Layer, Option, Queue, Stream } from "effect";
import { ChildSessionJournal } from "../../../src/runtime.ts";
import { childContinuation, CONTINUATION_MESSAGE } from "../../../src/harness/continuation.ts";
import { HarnessCatalog } from "../../../src/harness/harness.ts";
import { CodexAppServer, type CodexNotification } from "../../../src/harness/codex/app-server.ts";
import { codexRuntime } from "../../../src/harness/codex/codex.ts";
import { codex } from "../../../src/harness/codex/descriptor.ts";
import { request, successfulResponses, userMessage } from "./fixture.ts";

const savedSession = () =>
  HarnessSession.make({
    id: HarnessSessionId.make("thread-1"),
    cwd: request().cwd,
  });

const resumedResponses = (saved: HarnessSession) =>
  new Map(
    Object.entries({
      ...successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }]),
      "thread/resume": {
        modelProvider: "openai",
        thread: {
          id: saved.id,
          turns: [
            {
              id: "turn-0",
              status: "completed",
              items: [userMessage("task", request().prompt)],
            },
          ],
        },
      },
    }),
  );

/** Emits a `userMessage` item for `turnId` followed by a receipt barrier and awaits its save. */
const recordInTurn = (
  notifications: Queue.Queue<CodexNotification, Cause.Done>,
  receipts: Queue.Queue<ReadonlyArray<string>>,
  threadId: string,
  turnId: string,
  id: string,
  text: string,
) =>
  Effect.gen(function* () {
    for (const item of [userMessage(id, text), userMessage(`${id}-barrier`, "Receipt barrier")])
      yield* Queue.offer(notifications, {
        method: "item/started",
        params: { threadId, turnId, item },
      });
    while (!(yield* Queue.take(receipts)).includes(`${id}-barrier`)) yield* Effect.yieldNow;
  });

it.effect.each(["continuation", "operator message"] as const)(
  "keeps only own inputs queued during an interrupt (%s)",
  (pending) =>
    Effect.gen(function* () {
      const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
      const receipts = yield* Queue.make<ReadonlyArray<string>>();
      const nextTurn = yield* Deferred.make<void>();
      const reads: Array<OperatorMessageId> = [];
      let turns = 0;
      const saved = savedSession();
      const responses = resumedResponses(saved);
      const server = Layer.succeed(CodexAppServer)({
        stop: () => Effect.void,
        open: () =>
          Effect.succeed({
            notifications: Stream.fromQueue(notifications),
            notify: () => Effect.void,
            close: Queue.end(notifications).pipe(Effect.asVoid),
            request: (_operation, method) =>
              Effect.gen(function* () {
                if (method !== "turn/start") return responses.get(method) ?? {};
                turns += 1;
                if (turns === 2) yield* Deferred.succeed(nextTurn, undefined);
                return { turn: { id: `turn-${turns}` } };
              }),
          }),
      });
      yield* Effect.gen(function* () {
        const runtime = yield* codexRuntime;
        const sessions = childContinuation(HarnessCatalog.make({ descriptors: [codex] }), runtime);
        const resumed = yield* sessions.resume(request(), saved);
        assert(Option.isSome(resumed));
        const session = resumed.value;
        yield* session.recover([]);
        yield* session.running.interrupt;
        if (pending === "continuation") yield* session.recover([]);
        const repeated = OperatorMessage.make({ message: CONTINUATION_MESSAGE });
        yield* session.running.intervene(repeated, (state) =>
          Effect.sync(() => {
            if (Option.isSome(state)) reads.push(repeated.id);
          }),
        );
        assert.strictEqual(turns, 1, "the interrupt queues the next turn's inputs");
        yield* Queue.offer(notifications, {
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "interrupted", error: null } },
        });
        yield* Deferred.await(nextTurn);
        yield* recordInTurn(
          notifications,
          receipts,
          saved.id,
          "turn-2",
          "first",
          CONTINUATION_MESSAGE,
        );
        assert.deepStrictEqual(reads, pending === "continuation" ? [] : [repeated.id]);
        yield* recordInTurn(
          notifications,
          receipts,
          saved.id,
          "turn-2",
          "second",
          CONTINUATION_MESSAGE,
        );
        assert.deepStrictEqual(reads, [repeated.id]);
      }).pipe(
        Effect.provide([server, NodeServices.layer]),
        Effect.provideService(ChildSessionJournal, {
          ...ChildSessionJournal.noop,
          received: (items) => Queue.offer(receipts, items).pipe(Effect.asVoid),
        }),
      );
    }),
);

it.effect("drops an ended turn's own input when a bare steer queues during an interrupt", () =>
  Effect.gen(function* () {
    const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
    const receipts = yield* Queue.make<ReadonlyArray<string>>();
    const interruptStarted = yield* Deferred.make<void>();
    const interruptResponse = yield* Deferred.make<void>();
    const nextTurn = yield* Deferred.make<void>();
    const reads: Array<OperatorMessageId> = [];
    let turns = 0;
    const responses = new Map(
      Object.entries(successfulResponses([{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }])),
    );
    const server = Layer.succeed(CodexAppServer)({
      stop: () => Effect.void,
      open: () =>
        Effect.succeed({
          notifications: Stream.fromQueue(notifications),
          notify: () => Effect.void,
          close: Queue.end(notifications).pipe(Effect.asVoid),
          request: (_operation, method) =>
            Effect.gen(function* () {
              if (method === "turn/interrupt") {
                yield* Deferred.succeed(interruptStarted, undefined);
                yield* Deferred.await(interruptResponse);
                return {};
              }
              if (method !== "turn/start") return responses.get(method) ?? {};
              turns += 1;
              if (turns === 2) yield* Deferred.succeed(nextTurn, undefined);
              return { turn: { id: `turn-${turns}` } };
            }),
        }),
    });
    yield* Effect.gen(function* () {
      const runtime = yield* codexRuntime;
      const sessions = childContinuation(HarnessCatalog.make({ descriptors: [codex] }), runtime);
      const req = request();
      const running = yield* sessions.launch(req);
      const interrupting = yield* running.interrupt.pipe(Effect.forkChild);
      yield* Deferred.await(interruptStarted);
      yield* running.steer("Check the diff");
      const repeated = OperatorMessage.make({ message: req.prompt });
      yield* running.intervene(repeated, (state) =>
        Effect.sync(() => {
          if (Option.isSome(state)) reads.push(repeated.id);
        }),
      );
      assert.strictEqual(turns, 1, "the bare steer and operator message wait for turn 1 to end");
      yield* Queue.offer(notifications, {
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "interrupted", error: null } },
      });
      yield* Deferred.await(nextTurn);
      yield* recordInTurn(notifications, receipts, "thread-1", "turn-2", "bare", "Check the diff");
      assert.deepStrictEqual(reads, []);
      yield* recordInTurn(notifications, receipts, "thread-1", "turn-2", "op", req.prompt);
      assert.deepStrictEqual(
        reads,
        [repeated.id],
        "the bare steer did not retain turn 1's unrecorded task",
      );
      yield* Deferred.succeed(interruptResponse, undefined);
      yield* Fiber.join(interrupting);
    }).pipe(
      Effect.provide([server, NodeServices.layer]),
      Effect.provideService(ChildSessionJournal, {
        ...ChildSessionJournal.noop,
        received: (items) => Queue.offer(receipts, items).pipe(Effect.asVoid),
      }),
    );
  }),
);

it.effect(
  "keeps a next-turn continuation when the ending turn's own user message arrives late",
  () =>
    Effect.gen(function* () {
      const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
      const receipts = yield* Queue.make<ReadonlyArray<string>>();
      const turn1ReceiptRead = yield* Deferred.make<void>();
      const releaseTurn1Receipt = yield* Deferred.make<void>();
      const nextTurn = yield* Deferred.make<void>();
      const reads: Array<OperatorMessageId> = [];
      let turns = 0;
      const saved = savedSession();
      const responses = resumedResponses(saved);
      const turn1Notification: CodexNotification = {
        method: "item/started",
        params: {
          threadId: saved.id,
          turnId: "turn-1",
          item: userMessage("turn1-continuation", CONTINUATION_MESSAGE),
        },
      };
      const server = Layer.succeed(CodexAppServer)({
        stop: () => Effect.void,
        open: () =>
          Effect.succeed({
            notifications: Stream.fromQueue(notifications).pipe(
              Stream.tap((notification) =>
                notification === turn1Notification
                  ? Deferred.succeed(turn1ReceiptRead, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseTurn1Receipt)),
                    )
                  : Effect.void,
              ),
            ),
            notify: () => Effect.void,
            close: Queue.end(notifications).pipe(Effect.asVoid),
            request: (_operation, method) =>
              Effect.gen(function* () {
                if (method !== "turn/start") return responses.get(method) ?? {};
                turns += 1;
                if (turns === 2) yield* Deferred.succeed(nextTurn, undefined);
                return { turn: { id: `turn-${turns}` } };
              }),
          }),
      });
      yield* Effect.gen(function* () {
        const runtime = yield* codexRuntime;
        const sessions = childContinuation(HarnessCatalog.make({ descriptors: [codex] }), runtime);
        const resumed = yield* sessions.resume(request(), saved);
        assert(Option.isSome(resumed));
        const session = resumed.value;
        yield* session.recover([]);
        yield* Queue.offer(notifications, turn1Notification);
        yield* Deferred.await(turn1ReceiptRead);
        yield* session.running.interrupt;
        yield* session.recover([]);
        const repeated = OperatorMessage.make({ message: CONTINUATION_MESSAGE });
        yield* session.running.intervene(repeated, (state) =>
          Effect.sync(() => {
            if (Option.isSome(state)) reads.push(repeated.id);
          }),
        );
        yield* Queue.offer(notifications, {
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "interrupted", error: null } },
        });
        yield* Deferred.succeed(releaseTurn1Receipt, undefined);
        yield* Deferred.await(nextTurn);
        assert.deepStrictEqual(reads, [], "turn 1's delayed receipt read no next-turn input");
        yield* recordInTurn(
          notifications,
          receipts,
          saved.id,
          "turn-2",
          "first",
          CONTINUATION_MESSAGE,
        );
        assert.deepStrictEqual(reads, [], "turn 2's continuation was not consumed by turn 1");
        yield* recordInTurn(
          notifications,
          receipts,
          saved.id,
          "turn-2",
          "second",
          CONTINUATION_MESSAGE,
        );
        assert.deepStrictEqual(reads, [repeated.id]);
      }).pipe(
        Effect.provide([server, NodeServices.layer]),
        Effect.provideService(ChildSessionJournal, {
          ...ChildSessionJournal.noop,
          received: (items) => Queue.offer(receipts, items).pipe(Effect.asVoid),
        }),
      );
    }),
);
