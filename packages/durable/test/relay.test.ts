// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import {
  AgentSessionId,
  ChildSession,
  SessionStarted,
  TextOutput,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { DateTime, Deferred, Effect, Fiber, Option, Result } from "effect";
import { type AttemptResult, AttemptRecordDoc } from "../src/attempt/documents.ts";
import { type AttemptHub, attemptHubs } from "../src/attempt/hubs.ts";
import { childSessionId, parentSessionId } from "../src/attempt/parent.ts";
import { relayAttempt } from "../src/attempt/relay.ts";
import { DurableHarness } from "../src/harness.ts";
import { layer } from "../src/testing.ts";
import {
  assertAdmitted,
  attemptRequest,
  recordingSink,
  temporaryDatabase,
  trace,
} from "./support.ts";

it.live(
  "relays an Attempt without a parent session: Started, then early Worker notices, then child events",
  () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = attemptRequest("attempt-parentless");
      const attemptId = request.spec.attemptId;
      const child = ChildSession.make({
        id: AgentSessionId.make(childSessionId(attemptId, 1)),
        parentId: AgentSessionId.make(parentSessionId(attemptId)),
        agent: request.spec.agent.name,
        brain: request.spec.agent.brain,
      });
      const lastAnsweredAt = DateTime.makeUnsafe("2026-11-11T09:00:00Z");
      yield* Effect.gen(function* () {
        const durable = yield* DurableHarness;
        const hubs = yield* attemptHubs;
        yield* durable.subscribe(hubs.listener);
        const services = yield* Effect.context<never>();
        const run = Effect.runPromiseWith(services);
        // Completes with the Attempt's hub once its relay is attached.
        const relaying = yield* Deferred.make<AttemptHub>();
        // A coordinator stand-in: it marks the Attempt started without a parent conversation,
        // reports one child's events, and completes.
        const task = defineTask<null, { phase: "start" } | { phase: "work" }, AttemptResult>({
          name: "test.parentless-attempt",
          version: 1,
          initial: () => ({ phase: "start" }),
          phases: {
            start: async (_task, runtime, context) => {
              await run(Deferred.await(relaying));
              return runtime.commit(async (tx) => {
                (await tx.doc(AttemptRecordDoc, attemptId, null)).started = true;
                return { status: "running", checkpoint: { phase: "work" } };
              }, context);
            },
            work: async (_task, runtime, context) => {
              await run(
                Effect.gen(function* () {
                  const hub = yield* Deferred.await(relaying);
                  yield* hubs.event(hub, SessionStarted.make({ session: child }));
                  yield* hubs.event(hub, TextOutput.make({ session: child, text: "Fixed it." }));
                }),
              );
              return runtime.commit(
                () => ({
                  status: "terminal",
                  outcome: { status: "completed", result: { message: "Fixed it." } },
                }),
                context,
              );
            },
          },
          abort: (_task, runtime, context) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
        });
        yield* durable.install(defineExtension({ name: "test.parentless", tasks: [task] }));

        // Sent before the Attempt has a hub, so the relay keeps it until the Attempt starts.
        const kept = yield* hubs.notice(
          attemptId,
          AttemptChannel.WorkerUnresponsive.make({
            worker: request.worker,
            lastAnsweredAt,
            reason: "Connection timed out during banner exchange",
          }),
        );
        assert.strictEqual(kept._tag, "Kept");
        const taskId = yield* durable.use(
          "create the parentless task",
          async (harness, context) => {
            const root = await harness.root(context);
            return root.commit(async (tx) => {
              const created = await tx.createTask(task, null, {
                ownership: { kind: "conversation" },
              });
              (await tx.doc(AttemptRecordDoc, attemptId, null)).taskId = created;
              return created;
            }, context);
          },
        );
        const hub = yield* hubs.hub(attemptId, taskId);
        const recording = recordingSink();
        const relay = yield* Effect.forkChild(
          relayAttempt(durable, hubs, hub, request, recording.sink),
        );
        yield* hubs.attached(attemptId);
        assert.deepStrictEqual(recording.outbound(), []);
        yield* Deferred.succeed(relaying, hub);

        const settled = yield* Fiber.join(relay);
        assert.isTrue(Result.isSuccess(settled));
        const outbound = recording.outbound();
        assertAdmitted(attemptId, outbound);
        assert.deepStrictEqual(trace(outbound), [
          "Started",
          "WorkerUnresponsive",
          "child.SessionStarted",
          "child.TextOutput",
          "Final",
        ]);
        const started = outbound[0]?.payload;
        assert(started?._tag === "Started");
        assert.isTrue(Option.isNone(started.parentModel));
      }).pipe(Effect.scoped, Effect.provide(layer({ database, parent: [] })));
    }).pipe(Effect.scoped),
);
