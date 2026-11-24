import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { HarnessSession, HarnessSessionId } from "@usine/core/agent/session";
import { OperatorMessage, type OperatorMessageId } from "@usine/core/attempt/channel";
import { Cause, Deferred, Effect, Layer, Option, Queue, Stream } from "effect";
import { ChildSessionJournal } from "../../../src/runtime.ts";
import { childContinuation, CONTINUATION_MESSAGE } from "../../../src/harness/continuation.ts";
import { HarnessCatalog } from "../../../src/harness/harness.ts";
import { CodexAppServer, type CodexNotification } from "../../../src/harness/codex/app-server.ts";
import { codexRuntime } from "../../../src/harness/codex/codex.ts";
import { codex } from "../../../src/harness/codex/descriptor.ts";
import { request, successfulResponses, userMessage } from "./fixture.ts";

it.effect.each(["continuation", "operator message"] as const)(
  "keeps only own inputs queued during an interrupt (%s)",
  (pending) =>
    Effect.gen(function* () {
      const notifications = yield* Queue.make<CodexNotification, Cause.Done>();
      const receipts = yield* Queue.make<ReadonlyArray<string>>();
      const nextTurn = yield* Deferred.make<void>();
      const reads: Array<OperatorMessageId> = [];
      let turns = 0;
      const saved = HarnessSession.make({
        id: HarnessSessionId.make("thread-1"),
        cwd: request().cwd,
      });
      const responses = new Map(
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
      const record = (id: string, text: string) =>
        Effect.gen(function* () {
          for (const item of [
            userMessage(id, text),
            userMessage(`${id}-barrier`, "Receipt barrier"),
          ])
            yield* Queue.offer(notifications, {
              method: "item/started",
              params: { threadId: saved.id, turnId: "turn-2", item },
            });
          while (!(yield* Queue.take(receipts)).includes(`${id}-barrier`)) yield* Effect.yieldNow;
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
        yield* record("first", CONTINUATION_MESSAGE);
        assert.deepStrictEqual(reads, pending === "continuation" ? [] : [repeated.id]);
        yield* record("second", CONTINUATION_MESSAGE);
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
