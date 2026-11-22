import { assert, describe, it } from "@effect/vitest";
import type { AgentSessionEvent } from "@usine/core/agent/session";
import { Interrupt, Steer } from "@usine/core/attempt/channel";
import { Effect, Fiber, Option, Queue, Stream } from "effect";
import { ChildBackend } from "../../src/runtime.ts";
import {
  assertPrompt,
  childRequest,
  event,
  type ScriptedBridge,
  scriptedBackend,
  scriptedServer,
} from "./scripted-bridge.ts";

const tokens = (input: number, output: number) => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

/**
 * Launches the scripted child and runs its first execution up to a running tool call after the
 * text `before`. Returns the bridge, the running session, and its events as they arrive.
 */
const launched = (before: string) =>
  Effect.gen(function* () {
    const server = yield* scriptedServer;
    const fiber = yield* Effect.gen(function* () {
      const backend = yield* ChildBackend;
      return yield* backend.launch(childRequest);
    }).pipe(Effect.provide(scriptedBackend(server.layer)), Effect.forkScoped);
    const bridge = yield* server.bridge;
    const prompt = yield* bridge.request;
    assertPrompt(prompt, childRequest.prompt);
    yield* bridge.reply(prompt, 200, { data: { id: "msg_prompt" } });
    const running = yield* Fiber.join(fiber);
    const events = yield* Queue.unbounded<AgentSessionEvent>();
    const seen: Array<AgentSessionEvent> = [];
    const collector = yield* running.events.pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => seen.push(value)).pipe(Effect.andThen(Queue.offer(events, value))),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const until = (tag: AgentSessionEvent["_tag"]) =>
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Queue.take(events);
          if (next._tag === tag) return next;
        }
      });
    for (const line of [
      event("session.inbox.enqueued", { inboxID: "msg_prompt" }),
      event("session.execution.started"),
      event("session.inbox.delivered", { inboxID: "msg_prompt" }),
      event("session.text.ended", { text: before }),
      event("session.tool.input.started", { id: "call_1", name: "shell" }),
      event("session.tool.called", { id: "call_1", input: { command: "sleep 60" } }),
    ])
      yield* bridge.emit(line);
    yield* until("ToolStarted");
    /** Waits for the session's events to end. */
    const ended = Fiber.join(collector);
    return { bridge, running, until, seen, ended };
  });

/** Interrupts the running execution through the conversation and answers the interrupt. */
const interrupted = (
  bridge: ScriptedBridge,
  running: Effect.Success<ReturnType<typeof launched>>["running"],
) =>
  Effect.gen(function* () {
    const pause = yield* Effect.forkScoped(running.intervene(Interrupt.make(), () => Effect.void));
    const request = yield* bridge.request;
    assert.strictEqual(request.path, "/api/session/ses_scripted/interrupt");
    yield* bridge.reply(request, 200, { interrupted: true });
    yield* Fiber.join(pause);
  });

const oldExecutionEnds = [
  event("session.tool.failed", {
    id: "call_1",
    error: { type: "tool.execution", message: "killed" },
  }),
  event("session.execution.interrupted", { reason: "user" }),
];

const successor = (id: string) => [
  event("session.execution.started"),
  event("session.inbox.delivered", { inboxID: id }),
  event("session.text.ended", { text: "SUCCESSOR" }),
  event("session.step.ended"),
  event("session.execution.succeeded"),
];

describe("OpenCode runtime", () => {
  for (const order of ["steer answered first", "interrupted first"] as const)
    it.live(`ends the turn at the successor of a steer after an interrupt, ${order}`, () =>
      Effect.gen(function* () {
        const { bridge, running, seen, ended } = yield* launched("OLD");
        yield* interrupted(bridge, running);
        const guidance = Steer.make({ message: "Change the final reply." });
        const steering = yield* Effect.forkScoped(running.intervene(guidance, () => Effect.void));
        const posted = yield* bridge.request;
        const id = assertPrompt(posted, guidance.message);
        assert(Option.isSome(id), "the steer carries its OpenCode message ID");
        const answer = bridge.reply(posted, 200, { data: { id: id.value } });
        const enqueued = event("session.inbox.enqueued", { inboxID: id.value });
        if (order === "steer answered first") {
          yield* answer;
          yield* bridge.emit(enqueued);
          for (const line of oldExecutionEnds) yield* bridge.emit(line);
        } else {
          for (const line of oldExecutionEnds) yield* bridge.emit(line);
          // OpenCode answers the steer only after the old execution settled.
          yield* Effect.sleep("50 millis");
          yield* answer;
          yield* bridge.emit(enqueued);
        }
        yield* Fiber.join(steering);
        for (const line of successor(id.value)) yield* bridge.emit(line);
        const result = yield* running.result;
        yield* ended;
        assert.strictEqual(result.message, "SUCCESSOR");
        const tags = seen.map(({ _tag }) => _tag);
        assert.notInclude(
          tags,
          "SessionIdle",
          "the old execution's interrupt doesn't end the turn",
        );
        assert(
          seen.some(
            (value) => value._tag === "OperatorMessageRead" && value.messageId === guidance.id,
          ),
          "the session reports the steer as read",
        );
        assert.strictEqual(tags.at(-1), "SessionFinished");
      }).pipe(Effect.scoped),
    );

  it.live("ends the turn at the interrupt when the steer after it fails", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("OLD");
      yield* interrupted(bridge, running);
      const steering = yield* Effect.forkScoped(
        running.intervene(Steer.make({ message: "Change the final reply." }), () => Effect.void),
      );
      const posted = yield* bridge.request;
      for (const line of oldExecutionEnds) yield* bridge.emit(line);
      yield* Effect.sleep("50 millis");
      yield* bridge.reply(posted, 500, { message: "The session can't take input" });
      const refused = yield* Fiber.join(steering).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "SessionOperationError");
      const idle = yield* until("SessionIdle");
      assert(idle._tag === "SessionIdle");
      assert.deepStrictEqual(idle.message, Option.some("OLD"));
    }).pipe(Effect.scoped),
  );

  it.live("ends the turn at the interrupt when no steer follows it", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("OLD");
      yield* interrupted(bridge, running);
      for (const line of oldExecutionEnds) yield* bridge.emit(line);
      const idle = yield* until("SessionIdle");
      assert(idle._tag === "SessionIdle");
      assert.deepStrictEqual(idle.message, Option.some("OLD"));
    }).pipe(Effect.scoped),
  );

  it.live("retries a near rate limit and refuses a distant one as a capacity limit", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("OLD");
      const retry = (retryAfterMs: number, attempt: number) =>
        event("session.retry.scheduled", {
          assistantMessageID: "msg_step",
          attempt,
          at: 1_800_000_000_000 + retryAfterMs,
          error: {
            type: "provider.rate-limit",
            message: "Rate limit reached for requests",
            status: 429,
            retryAfterMs,
          },
        });
      yield* bridge.emit(retry(7_000, 1));
      const retrying = yield* until("ProviderRetrying");
      assert(retrying._tag === "ProviderRetrying");
      assert.strictEqual(retrying.message, "Rate limit reached for requests");
      yield* bridge.emit(retry(600_000, 2));
      const refusal = yield* running.result.pipe(Effect.flip);
      assert(refusal._tag === "AgentCapacityError");
      assert.deepStrictEqual(
        Option.map(refusal.resetsAt, (resetsAt) => resetsAt.epochMilliseconds),
        Option.some(1_800_000_600_000),
      );
    }).pipe(Effect.scoped),
  );

  it.live("refuses a quota as a capacity limit without a reset time", () =>
    Effect.gen(function* () {
      const { bridge, running } = yield* launched("OLD");
      yield* bridge.emit(
        event("session.execution.failed", {
          error: {
            type: "provider.quota",
            message: "You exceeded your current quota.",
            status: 429,
          },
        }),
      );
      const refusal = yield* running.result.pipe(Effect.flip);
      assert(refusal._tag === "AgentCapacityError");
      assert.include(refusal.message, "provider.quota");
      assert(Option.isNone(refusal.resetsAt));
    }).pipe(Effect.scoped),
  );

  it.live("returns the answer of the execution that background work wakes, with its tokens", () =>
    Effect.gen(function* () {
      const { bridge, running, until, seen, ended } = yield* launched("Started the tests.");
      yield* bridge.setJobs([{ kind: "shell", id: "sh_1", status: "running", title: "pnpm test" }]);
      for (const line of [
        event("session.tool.success", {
          id: "call_1",
          content: [{ type: "text", text: "Command moved to the background" }],
        }),
        event("session.text.ended", { text: "FIRST" }),
        event("session.step.ended"),
        event("session.usage.updated", { cost: 0.01, tokens: tokens(100, 10) }),
        event("session.execution.succeeded"),
      ])
        yield* bridge.emit(line);
      const waiting = yield* until("BackgroundWorkUpdated");
      assert(waiting._tag === "BackgroundWorkUpdated");
      assert.deepStrictEqual(
        Option.map(waiting.work, (work) => work.map(({ id }) => id)),
        Option.some(["sh_1"]),
      );
      yield* bridge.setJobs([]);
      for (const line of [
        event("session.inbox.enqueued", { inboxID: "msg_synthetic" }),
        event("session.execution.started"),
        event("session.inbox.delivered", { inboxID: "msg_synthetic" }),
        event("session.text.ended", { text: "WOKEN" }),
        event("session.step.ended"),
        event("session.usage.updated", { cost: 0.03, tokens: tokens(250, 30) }),
        event("session.execution.succeeded"),
      ])
        yield* bridge.emit(line);
      const result = yield* running.result;
      yield* ended;
      assert.strictEqual(result.message, "WOKEN");
      const usage = seen.flatMap((value) => (value._tag === "SessionTokensUpdated" ? [value] : []));
      assert.strictEqual(usage.at(-1)?.totalTokens, 280);
      assert.deepStrictEqual(usage.at(-1)?.costUsd, Option.some(0.03));
      assert.strictEqual(seen.at(-1)?._tag, "SessionFinished");
    }).pipe(Effect.scoped),
  );
});
