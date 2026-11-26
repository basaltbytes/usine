import { assert, describe, it } from "@effect/vitest";
import { Interrupt, Steer } from "@usine/core/attempt/channel";
import { Effect, Fiber, Option } from "effect";
import {
  assertPrompt,
  event,
  execution,
  interrupted,
  launched,
  oldExecutionEnds,
  SESSION,
} from "./scripted-bridge.ts";

describe("OpenCode runtime", () => {
  it.live("sets the command environment of its session before it posts the task", () =>
    Effect.gen(function* () {
      const { bridge } = yield* launched("OLD");
      const environments = yield* bridge.environments;
      assert.deepStrictEqual(environments, [SESSION]);
      const answered = yield* bridge.answered;
      assert(
        answered.every(({ path }) => !path.endsWith("/prompt")),
        "the bridge answers no prompt by itself",
      );
    }).pipe(Effect.scoped),
  );

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
        for (const line of execution(id.value, "SUCCESSOR")) yield* bridge.emit(line);
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

  it.live("ends the interrupted turn when its late steer failed before the terminal event", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("OLD");
      yield* interrupted(bridge, running);
      const steering = yield* Effect.forkScoped(
        running.intervene(Steer.make({ message: "Change the final reply." }), () => Effect.void),
      );
      const posted = yield* bridge.request;
      yield* bridge.reply(posted, 500, { message: "The session can't take input" });
      const refused = yield* Fiber.join(steering).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "SessionOperationError");
      for (const line of oldExecutionEnds) yield* bridge.emit(line);
      const idle = yield* until("SessionIdle");
      assert(idle._tag === "SessionIdle");
      assert.deepStrictEqual(idle.message, Option.some("OLD"));
    }).pipe(Effect.scoped),
  );

  it.live("retries an interrupt that OpenCode refused in the same execution", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("OLD");
      const pause = yield* Effect.forkScoped(
        running.intervene(Interrupt.make(), () => Effect.void),
      );
      const first = yield* bridge.request;
      assert.strictEqual(first.path, `/api/session/${SESSION}/interrupt`);
      yield* bridge.reply(first, 500, { message: "Interrupt failed" });
      const refused = yield* Fiber.join(pause).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "SessionOperationError");
      yield* interrupted(bridge, running);
      for (const line of oldExecutionEnds) yield* bridge.emit(line);
      const idle = yield* until("SessionIdle");
      assert(idle._tag === "SessionIdle");
      assert.deepStrictEqual(idle.message, Option.some("OLD"));
    }).pipe(Effect.scoped),
  );

  it.live("ends the turn at the interrupt when a steer comes before the interrupt's answer", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("OLD");
      const pause = yield* Effect.forkScoped(
        running.intervene(Interrupt.make(), () => Effect.void),
      );
      const interrupt = yield* bridge.request;
      assert.strictEqual(interrupt.path, `/api/session/${SESSION}/interrupt`);
      // The steer goes out before OpenCode answers the interrupt, so it starts no successor.
      const steering = yield* Effect.forkScoped(running.steer("Use the other approach."));
      const posted = yield* bridge.request;
      assertPrompt(posted, "Use the other approach.");
      yield* bridge.reply(posted, 200, { data: { id: "msg_early" } });
      yield* Fiber.join(steering);
      yield* bridge.reply(interrupt, 200, { interrupted: true });
      yield* Fiber.join(pause);
      yield* bridge.emit(event("session.inbox.enqueued", { inboxID: "msg_early" }));
      for (const line of oldExecutionEnds) yield* bridge.emit(line);
      const idle = yield* until("SessionIdle");
      assert(idle._tag === "SessionIdle");
      assert.deepStrictEqual(idle.message, Option.some("OLD"));
    }).pipe(Effect.scoped),
  );

  it.live("ends a later interrupt's turn once the successor delivered the late steer", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("OLD");
      yield* interrupted(bridge, running);
      const guidance = Steer.make({ message: "Change the final reply." });
      const steering = yield* Effect.forkScoped(running.intervene(guidance, () => Effect.void));
      const posted = yield* bridge.request;
      const id = assertPrompt(posted, guidance.message);
      assert(Option.isSome(id));
      yield* bridge.reply(posted, 200, { data: { id: id.value } });
      yield* Fiber.join(steering);
      for (const line of [
        event("session.inbox.enqueued", { inboxID: id.value }),
        ...oldExecutionEnds,
        event("session.execution.started"),
        event("session.inbox.delivered", { inboxID: id.value }),
        event("session.text.ended", { text: "SUCCESSOR" }),
        event("session.tool.input.started", { id: "call_2", name: "shell" }),
        event("session.tool.called", { id: "call_2", input: { command: "sleep 60" } }),
      ])
        yield* bridge.emit(line);
      yield* until("ToolStarted");
      yield* interrupted(bridge, running);
      for (const line of [
        event("session.tool.failed", {
          id: "call_2",
          error: { type: "tool.execution", message: "killed" },
        }),
        event("session.execution.interrupted", { reason: "user" }),
      ])
        yield* bridge.emit(line);
      const idle = yield* until("SessionIdle");
      assert(idle._tag === "SessionIdle");
      assert.deepStrictEqual(idle.message, Option.some("SUCCESSOR"));
    }).pipe(Effect.scoped),
  );

  it.live("interrupts again after an interrupt that the execution's success overtook", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("OLD");
      const pause = yield* Effect.forkScoped(
        running.intervene(Interrupt.make(), () => Effect.void),
      );
      const first = yield* bridge.request;
      assert.strictEqual(first.path, `/api/session/${SESSION}/interrupt`);
      for (const line of [
        event("session.tool.success", { id: "call_1", content: [{ type: "text", text: "done" }] }),
        event("session.text.ended", { text: "FIRST" }),
        event("session.step.ended"),
        event("session.execution.succeeded"),
      ])
        yield* bridge.emit(line);
      yield* bridge.reply(first, 200, { interrupted: false });
      yield* Fiber.join(pause);
      const idle = yield* until("SessionIdle");
      assert(idle._tag === "SessionIdle");
      assert.deepStrictEqual(idle.message, Option.some("FIRST"));
      const guidance = Steer.make({ message: "Run the tests again." });
      const steering = yield* Effect.forkScoped(running.intervene(guidance, () => Effect.void));
      const posted = yield* bridge.request;
      const id = assertPrompt(posted, guidance.message);
      assert(Option.isSome(id));
      yield* bridge.reply(posted, 200, { data: { id: id.value } });
      yield* Fiber.join(steering);
      for (const line of [
        event("session.inbox.enqueued", { inboxID: id.value }),
        event("session.execution.started"),
        event("session.inbox.delivered", { inboxID: id.value }),
        event("session.tool.input.started", { id: "call_2", name: "shell" }),
        event("session.tool.called", { id: "call_2", input: { command: "pnpm test" } }),
      ])
        yield* bridge.emit(line);
      yield* until("ToolStarted");
      const second = yield* Effect.forkScoped(
        running.intervene(Interrupt.make(), () => Effect.void),
      );
      const request = yield* bridge.request.pipe(Effect.timeoutOption("2 seconds"));
      assert(Option.isSome(request), "the second interrupt reaches OpenCode");
      assert.strictEqual(request.value.path, `/api/session/${SESSION}/interrupt`);
      yield* bridge.reply(request.value, 200, { interrupted: true });
      yield* Fiber.join(second);
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

  for (const type of [
    "provider.quota",
    "provider.rate-limit",
    "provider.go-limit",
    "provider.chatgpt-limit",
    "provider.free-limit",
    "provider.budget-limit",
  ])
    it.live(`refuses ${type} as a capacity limit without a reset time`, () =>
      Effect.gen(function* () {
        const { bridge, running } = yield* launched("OLD");
        yield* bridge.emit(
          event("session.execution.failed", {
            error: { type, message: "You exceeded your current quota.", status: 429 },
          }),
        );
        const refusal = yield* running.result.pipe(Effect.flip);
        assert(refusal._tag === "AgentCapacityError");
        assert.include(refusal.message, type);
        assert(Option.isNone(refusal.resetsAt));
      }).pipe(Effect.scoped),
    );

  it.live("fails the session on another execution failure", () =>
    Effect.gen(function* () {
      const { bridge, running } = yield* launched("OLD");
      yield* bridge.emit(
        event("session.execution.failed", {
          error: { type: "provider.auth", message: "Incorrect API key provided." },
        }),
      );
      const failure = yield* running.result.pipe(Effect.flip);
      assert(failure._tag === "AgentResultError");
      assert.include(failure.message, "provider.auth");
    }).pipe(Effect.scoped),
  );
});
