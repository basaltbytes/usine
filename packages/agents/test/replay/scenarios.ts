import { assert } from "@effect/vitest";
import {
  OperatorMessage,
  Interrupt,
  Release,
  type InterventionState,
} from "@usine/core/attempt/channel";
import type { AgentSessionEvent } from "@usine/core/agent/session";
import { Effect, Fiber, FileSystem, Option, Queue, Result, Schema, Stream } from "effect";
import { ChildBackend, ChildRequest, SessionOperationError } from "../../src/runtime.ts";
import type { Scenario } from "./transcript.ts";

export const waitScript = `const fs = require('node:fs');
fs.writeFileSync('started', 'ready');
const timer = setInterval(() => {
  if (fs.existsSync('release')) { clearInterval(timer); process.exit(0); }
}, 25);
setTimeout(() => process.exit(1), 120000).unref();
`;
export const waitingPrompt =
  "Run exactly `node wait.cjs` with your command tool and wait for it to finish. " +
  "Then reply with exactly REPLAY_DONE. The test controls the command. Do not use any other tools.";
const guidance = "Change the final reply to exactly REPLAY_GUIDED. Do not use any more tools.";

export const runScenario = (
  scenario: Scenario,
  base: ChildRequest,
  controls?: {
    readonly drop: Effect.Effect<void>;
    readonly boundary: Effect.Effect<void>;
    readonly toolReady: Effect.Effect<void>;
    readonly releaseCommand: Effect.Effect<void>;
    readonly sessionReleased: Effect.Effect<void>;
    readonly nativeReceipts?: boolean;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const backend = yield* ChildBackend;
      const control = controls ?? {
        drop: Effect.void,
        boundary: Effect.void,
        toolReady: Effect.void,
        releaseCommand: fs.writeFileString(`${base.cwd}/release`, "ready").pipe(Effect.orDie),
        sessionReleased: Effect.void,
      };
      if (scenario !== "simple") yield* fs.writeFileString(`${base.cwd}/wait.cjs`, waitScript);
      const request =
        scenario === "simple" ? base : ChildRequest.make({ ...base, prompt: waitingPrompt });
      if (scenario === "early-exit") {
        const failure = yield* backend.launch(base).pipe(Effect.flip);
        assert(Schema.is(SessionOperationError)(failure), "early exit is a transport failure");
        return [];
      }
      const running = yield* backend.launch(request);
      const events: Array<AgentSessionEvent> = [];
      const pending = yield* Queue.unbounded<AgentSessionEvent>();
      const collected = yield* running.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(Effect.andThen(Queue.offer(pending, event))),
        ),
        Effect.forkScoped,
      );
      const until = (tag: AgentSessionEvent["_tag"]) =>
        Effect.gen(function* () {
          for (;;) {
            const event = yield* Queue.take(pending);
            if (event._tag === tag) return event;
          }
        }).pipe(Effect.timeout("90 seconds"));
      const releaseCommand = control.releaseCommand;
      if (scenario !== "simple") yield* until("ToolStarted");
      if (scenario === "transport-loss") yield* control.drop;
      if (scenario === "steer") yield* running.steer(guidance);
      if (scenario === "queued-message" || scenario === "hold-release") {
        const delivery = yield* Queue.unbounded<Option.Option<InterventionState>>();
        const state = yield* running.intervene(
          OperatorMessage.make({ message: guidance }),
          (taken) => Queue.offer(delivery, taken).pipe(Effect.asVoid),
        );
        assert(state.held);
        assert(state.queued);
        yield* releaseCommand;
        yield* until("SessionIdle");
        if (controls?.nativeReceipts !== false) {
          const delivered = yield* Queue.take(delivery);
          assert(Option.isSome(delivered));
          assert(delivered.value.held);
          assert(!delivered.value.queued);
        } else {
          const reports = yield* Queue.clear(delivery);
          assert.deepStrictEqual(reports, [], "legacy traffic contains no native receipts");
        }
        assert(!events.some((event) => event._tag === "SessionFinished"));
        if (scenario === "hold-release") {
          yield* running.intervene(
            OperatorMessage.make({
              message: "Reply with exactly REPLAY_SECOND. Do not use tools.",
            }),
            () => Effect.void,
          );
          yield* until("SessionResumed");
          yield* until("SessionIdle");
        }
        yield* running.intervene(Release.make(), () => Effect.void);
        yield* control.sessionReleased;
      } else if (scenario === "interrupt-guidance") {
        yield* control.toolReady;
        yield* running.intervene(Interrupt.make(), () => Effect.void);
        yield* releaseCommand;
        if (base.session.brain.harness === "claude") yield* control.boundary;
        else yield* until("SessionIdle");
        yield* running.intervene(OperatorMessage.make({ message: guidance }), () => Effect.void);
        yield* until("SessionResumed");
        yield* until("SessionIdle");
        yield* running.intervene(Release.make(), () => Effect.void);
        yield* control.sessionReleased;
      } else if (scenario !== "simple") {
        yield* releaseCommand;
      }
      const result = yield* running.result.pipe(Effect.timeout("90 seconds"));
      yield* Fiber.join(collected);
      const expected =
        scenario === "hold-release"
          ? "REPLAY_SECOND"
          : scenario === "simple" || scenario === "transport-loss"
            ? "REPLAY_DONE"
            : "REPLAY_GUIDED";
      assert.include(result.message, expected);
      assert.strictEqual(events[0]?._tag, "SessionStarted");
      assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
      assert(events.some((event) => event._tag === "TextOutput" && event.text.includes(expected)));
      if (scenario === "interrupt-guidance") {
        yield* fs.remove(`${base.cwd}/release`);
        const interrupted = yield* backend.launch(request);
        const started = yield* Queue.unbounded<void>();
        const output: Array<AgentSessionEvent> = [];
        const draining = yield* interrupted.events.pipe(
          Stream.runForEach((event) => {
            output.push(event);
            return event._tag === "ToolStarted" ? Queue.offer(started, undefined) : Effect.void;
          }),
          Effect.result,
          Effect.forkScoped,
        );
        yield* Queue.take(started);
        yield* interrupted.interrupt;
        const outcome = yield* interrupted.result.pipe(Effect.result, Effect.timeout("30 seconds"));
        const stream = yield* Fiber.join(draining);
        assert.strictEqual(stream._tag, outcome._tag);
        if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "AgentResultError");
        else assert.notInclude(outcome.success.message, "REPLAY_DONE");
        assert(
          !output.some(
            (event) => event._tag === "TextOutput" && event.text.includes("REPLAY_DONE"),
          ),
        );
      }
      return events;
    }),
  );
