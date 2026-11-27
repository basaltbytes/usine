import { assert, describe, it } from "@effect/vitest";
import { Interrupt, Steer } from "@usine/core/attempt/channel";
import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import {
  assertPrompt,
  event,
  firstExecutionEnds,
  interrupted,
  launched,
  oldExecutionEnds,
  SESSION,
  shell,
} from "./scripted-bridge.ts";

const CHILD = "ses_child";

describe("OpenCode turn", () => {
  for (const work of ["a shell", "a child execution"] as const)
    it.effect(`returns the answer after ${work} ends without waking the root`, () =>
      Effect.gen(function* () {
        const { bridge, running, until } = yield* launched("Started the tests.");
        for (const line of [
          ...(work === "a shell"
            ? [{ event: { type: "shell.created", data: { info: shell("sh_1", SESSION) } } }]
            : [
                event("session.created", { sessionID: CHILD, parentID: SESSION, title: "review" }),
                event("session.execution.started", { sessionID: CHILD }),
              ]),
          ...firstExecutionEnds,
        ])
          yield* bridge.emit(line);
        yield* until("BackgroundWorkUpdated");
        yield* bridge.emit(
          work === "a shell"
            ? { event: { type: "shell.exited", data: { id: "sh_1", exit: 0, status: "exited" } } }
            : event("session.execution.succeeded", { sessionID: CHILD }),
        );
        const result = yield* Effect.forkScoped(running.result);
        for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
        yield* TestClock.adjust("30 minutes");
        for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
        const polled = yield* Effect.sync(() => result.pollUnsafe());
        assert(polled !== undefined, "the session returned after the work ended");
      }).pipe(Effect.scoped),
    );

  it.live("checks no background work that ends while a root execution runs", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("Started the tests.");
      for (const line of [
        { event: { type: "shell.created", data: { info: shell("sh_1", SESSION) } } },
        ...firstExecutionEnds,
      ])
        yield* bridge.emit(line);
      yield* until("BackgroundWorkUpdated");
      for (const line of [
        event("session.execution.started"),
        { event: { type: "shell.exited", data: { id: "sh_1", exit: 0, status: "exited" } } },
      ])
        yield* bridge.emit(line);
      yield* Effect.sleep("200 millis");
      const answered = yield* bridge.answered;
      assert(
        !answered.some(({ path }) => path.startsWith("/api/experimental/job")),
        "the running execution's own end checks the work",
      );
      for (const line of [
        event("session.text.ended", { text: "SECOND" }),
        event("session.step.ended"),
        event("session.execution.succeeded"),
      ])
        yield* bridge.emit(line);
      const result = yield* running.result;
      assert.strictEqual(result.message, "SECOND");
    }).pipe(Effect.scoped),
  );

  it.live("ends the turn when OpenCode cancels the late steer after the interrupt", () =>
    Effect.gen(function* () {
      const { bridge, running } = yield* launched("OLD");
      yield* interrupted(bridge, running);
      const guidance = Steer.make({ message: "Change the final reply." });
      const steering = yield* Effect.forkScoped(running.intervene(guidance, () => Effect.void));
      const posted = yield* bridge.request;
      const id = assertPrompt(posted, guidance.message);
      assert(Option.isSome(id));
      yield* bridge.reply(posted, 200, { data: { id: id.value } });
      yield* Fiber.join(steering);
      yield* bridge.emit(event("session.inbox.enqueued", { inboxID: id.value }));
      for (const line of oldExecutionEnds) yield* bridge.emit(line);
      yield* bridge.emit(event("session.inbox.cancelled", { inboxID: id.value }));
      const done = yield* running.result.pipe(Effect.timeoutOption("1 second"));
      assert(Option.isSome(done), "the turn ended");
      assert.strictEqual(done.value.message, "OLD");
    }).pipe(Effect.scoped),
  );

  it.live(
    "pauses the execution that queued input starts after an Interrupt between executions",
    () =>
      Effect.gen(function* () {
        const { bridge, running } = yield* launched("OLD");
        const steering = yield* Effect.forkScoped(running.steer("Reply STEERED instead."));
        const posted = yield* bridge.request;
        yield* bridge.reply(posted, 200, { data: { id: "msg_own" } });
        yield* Fiber.join(steering);
        yield* bridge.emit(event("session.inbox.enqueued", { inboxID: "msg_own" }));
        for (const line of firstExecutionEnds) yield* bridge.emit(line);
        yield* Effect.sleep("100 millis");
        yield* running.intervene(Interrupt.make(), () => Effect.void);
        for (const line of [
          event("session.execution.started"),
          event("session.inbox.delivered", { inboxID: "msg_own" }),
          event("session.tool.input.started", { id: "call_2", name: "shell" }),
          event("session.tool.called", { id: "call_2", input: { command: "sleep 60" } }),
        ])
          yield* bridge.emit(line);
        const request = yield* bridge.request.pipe(Effect.timeoutOption("1 second"));
        assert(
          Option.exists(request, ({ path }) => path.endsWith("/interrupt")),
          "an interrupt reaches the execution that started after the pause",
        );
      }).pipe(Effect.scoped),
  );

  for (const { end, order, answer } of [
    { end: "delivered", order: "after", answer: "STEERED" },
    { end: "delivered", order: "before", answer: "OLD" },
    { end: "cancelled", order: "after", answer: "OLD" },
  ] as const)
    it.live(
      `ends the paused turn with ${answer} once OpenCode ${end} the late steer ${order} the interrupt, before its post's answer`,
      () =>
        Effect.gen(function* () {
          const { bridge, running, until } = yield* launched("OLD");
          yield* interrupted(bridge, running);
          // A steer without an operator message ID gets its inbox ID only from the post's answer.
          const steering = yield* Effect.forkScoped(running.steer("Reply STEERED instead."));
          const posted = yield* bridge.request;
          const steerEnds = event(
            end === "delivered" ? "session.inbox.delivered" : "session.inbox.cancelled",
            { inboxID: "msg_late" },
          );
          // Delivered before the interrupt, the steer is read by the interrupted execution.
          const lines =
            order === "after" ? [...oldExecutionEnds, steerEnds] : [steerEnds, ...oldExecutionEnds];
          for (const line of lines) yield* bridge.emit(line);
          // OpenCode answers the post only after it reported the steer's end.
          yield* Effect.sleep("50 millis");
          yield* bridge.reply(posted, 200, { data: { id: "msg_late" } });
          yield* Fiber.join(steering);
          if (answer === "STEERED")
            for (const line of [
              event("session.execution.started"),
              event("session.text.ended", { text: "STEERED" }),
              event("session.step.ended"),
              event("session.execution.succeeded"),
            ])
              yield* bridge.emit(line);
          const idle = yield* until("SessionIdle").pipe(Effect.timeoutOption("2 seconds"));
          assert(Option.isSome(idle), "the turn ended");
          assert(idle.value._tag === "SessionIdle");
          assert.deepStrictEqual(
            idle.value.message,
            Option.some(answer),
            answer === "STEERED"
              ? "the successor that read the steer ends the turn"
              : "the interrupted execution's answer ends the turn",
          );
        }).pipe(Effect.scoped),
    );

  it.live(
    "waits for the successor of a late operator steer that OpenCode delivered before its post failed",
    () =>
      Effect.gen(function* () {
        const { bridge, running, until } = yield* launched("OLD");
        yield* interrupted(bridge, running);
        const guidance = Steer.make({ message: "Reply STEERED instead." });
        const steering = yield* Effect.forkScoped(running.intervene(guidance, () => Effect.void));
        const posted = yield* bridge.request;
        const id = assertPrompt(posted, guidance.message);
        assert(Option.isSome(id));
        for (const line of [
          event("session.inbox.enqueued", { inboxID: id.value }),
          ...oldExecutionEnds,
          event("session.inbox.delivered", { inboxID: id.value }),
        ])
          yield* bridge.emit(line);
        yield* Effect.sleep("50 millis");
        yield* bridge.reply(posted, 500, { message: "The bridge dropped the answer" });
        yield* Fiber.await(steering);
        const early = yield* until("SessionIdle").pipe(Effect.timeoutOption("200 millis"));
        assert(Option.isNone(early), "the failed post of a delivered steer doesn't end the turn");
        for (const line of [
          event("session.execution.started"),
          event("session.text.ended", { text: "STEERED" }),
          event("session.step.ended"),
          event("session.execution.succeeded"),
        ])
          yield* bridge.emit(line);
        const idle = yield* until("SessionIdle");
        assert(idle._tag === "SessionIdle");
        assert.deepStrictEqual(idle.message, Option.some("STEERED"));
      }).pipe(Effect.scoped),
  );

  it.live("pauses an execution that starts while a re-run done check reads the jobs", () =>
    Effect.gen(function* () {
      const { bridge, running, until } = yield* launched("OLD");
      const steering = yield* Effect.forkScoped(running.steer("Reply STEERED instead."));
      const posted = yield* bridge.request;
      for (const line of firstExecutionEnds) yield* bridge.emit(line);
      yield* Effect.sleep("50 millis");
      // The failed post makes the answer due, so the done check runs again and reads the jobs.
      yield* bridge.holdNext("jobs");
      yield* bridge.reply(posted, 500, { message: "The session can't take input" });
      yield* Fiber.await(steering);
      const jobs = yield* bridge.request;
      assert(jobs.path.startsWith("/api/experimental/job"));
      for (const line of [
        event("session.execution.started"),
        event("session.tool.input.started", { id: "call_2", name: "shell" }),
        event("session.tool.called", { id: "call_2", input: { command: "sleep 60" } }),
      ])
        yield* bridge.emit(line);
      yield* Effect.sleep("50 millis");
      yield* bridge.reply(jobs, 200, {
        data: [{ kind: "shell", id: "sh_1", status: "running", title: "test" }],
      });
      yield* Effect.sleep("50 millis");
      const pause = yield* Effect.forkScoped(
        running.intervene(Interrupt.make(), () => Effect.void),
      );
      const request = yield* bridge.request.pipe(Effect.timeoutOption("1 second"));
      assert(
        Option.exists(request, ({ path }) => path.endsWith("/interrupt")),
        "the pause interrupts the execution that started during the done check",
      );
      if (Option.isSome(request)) yield* bridge.reply(request.value, 200, { interrupted: true });
      yield* Fiber.await(pause);
      for (const line of [
        event("session.tool.failed", {
          id: "call_2",
          error: { type: "tool.execution", message: "killed" },
        }),
        event("session.execution.interrupted", { reason: "user" }),
      ])
        yield* bridge.emit(line);
      // The check's jobs list ran ahead of the started execution, so its `sh_1` isn't that
      // execution's work, and the paused answer doesn't wait for it.
      const idle = yield* until("SessionIdle").pipe(Effect.timeoutOption("3 seconds"));
      assert(Option.isSome(idle), "the paused execution's answer ends the turn");
    }).pipe(Effect.scoped),
  );

  it.live("answers after a steer whose post was interrupted", () =>
    Effect.gen(function* () {
      const { bridge, running } = yield* launched("OLD");
      const steering = yield* Effect.forkScoped(running.steer("Reply STEERED instead."));
      yield* bridge.request;
      yield* Fiber.interrupt(steering);
      for (const line of firstExecutionEnds) yield* bridge.emit(line);
      const done = yield* running.result.pipe(Effect.timeoutOption("1 second"));
      assert(Option.isSome(done), "the session answered");
    }).pipe(Effect.scoped),
  );
});
