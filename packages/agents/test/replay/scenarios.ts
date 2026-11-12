import { assert } from "@effect/vitest";
import {
  OperatorMessage,
  Interrupt,
  Release,
  type InterventionState,
} from "@usine/core/attempt/channel";
import type { AgentSessionEvent, HarnessSession } from "@usine/core/agent/session";
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

/**
 * Starts the waiting task, stops the session while its command runs, as an orchestrator restart
 * does, and reopens the saved conversation, which continues to the final reply.
 */
const restart = (base: ChildRequest) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const backend = yield* ChildBackend;
    yield* fs.writeFileString(`${base.cwd}/wait.cjs`, waitScript);
    const request = ChildRequest.make({ ...base, prompt: waitingPrompt });
    const reference = yield* Effect.scoped(
      Effect.gen(function* () {
        const running = yield* backend.launch(request);
        const events = yield* Queue.unbounded<AgentSessionEvent>();
        yield* running.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        let saved = Option.none<HarnessSession>();
        for (;;) {
          const event = yield* Queue.take(events);
          if (event._tag === "SessionStarted") saved = event.harnessSession;
          if (event._tag === "ToolStarted") break;
        }
        assert(Option.isSome(saved), "the session saves its conversation before the first turn");
        return saved.value;
      }),
    ).pipe(Effect.timeout("90 seconds"));
    yield* fs.writeFileString(`${base.cwd}/release`, "ready");
    const resumed = yield* backend.launch(
      ChildRequest.make({ ...request, resume: Option.some(reference) }),
    );
    const collected = yield* Effect.forkScoped(Stream.runCollect(resumed.events));
    const result = yield* resumed.result.pipe(Effect.timeout("90 seconds"));
    const events = yield* Fiber.join(collected);
    assert.include(result.message, "REPLAY_DONE");
    const started = events[0];
    assert(started?._tag === "SessionStarted");
    assert.deepStrictEqual(
      Option.map(started.harnessSession, ({ id }) => id),
      Option.some(reference.id),
      "the session reopens the saved conversation",
    );
    assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
    return [...events];
  });

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
      if (scenario === "restart") return yield* restart(base);
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
          const second = yield* running.intervene(
            OperatorMessage.make({
              message: "Reply with exactly REPLAY_SECOND. Do not use tools.",
            }),
            (taken) => Queue.offer(delivery, taken).pipe(Effect.asVoid),
          );
          yield* until("SessionResumed");
          yield* until("SessionIdle");
          // A harness that starts the turn with the message reads it at once, with no later receipt.
          if (second.queued) {
            const delivered = yield* Queue.take(delivery);
            assert(Option.isSome(delivered));
            assert(delivered.value.held);
            assert(!delivered.value.queued);
          } else {
            const receipts = yield* Queue.clear(delivery);
            assert.deepStrictEqual(receipts, []);
          }
        }
        yield* running.intervene(Release.make(), () => Effect.void);
        yield* control.sessionReleased;
      } else if (scenario === "interrupt-guidance") {
        yield* control.toolReady;
        yield* running.intervene(Interrupt.make(), () => Effect.void);
        yield* releaseCommand;
        const harness = base.session.brain.harness;
        // Claude Code and Pi hold the turn at their next tool or model boundary; Codex ends it.
        if (harness === "claude") yield* control.boundary;
        else if (harness === "pi") yield* until("ToolFinished");
        else yield* until("SessionIdle");
        yield* running.intervene(OperatorMessage.make({ message: guidance }), () => Effect.void);
        yield* until("SessionResumed");
        yield* until("SessionIdle");
        if (harness === "pi") {
          // Pi's pause gate holds the model request after the interrupted tool, so no text
          // arrives until the guidance resumes the session.
          const resumed = events.findIndex((event) => event._tag === "SessionResumed");
          const text = events.findIndex((event) => event._tag === "TextOutput");
          assert.isAbove(text, resumed, "Pi writes no text before the guidance resumes it");
        }
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
      assert.lengthOf(
        events.filter((event) => event._tag === "SessionStarted"),
        1,
      );
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
