import { assert, describe, it } from "@effect/vitest";
import { Interrupt, Steer } from "@usine/core/attempt/channel";
import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { ChildRequest } from "../../src/runtime.ts";
import {
  assertPrompt,
  childRequest,
  event,
  interrupted,
  launched,
  oldExecutionEnds,
  SESSION,
  tokens,
} from "./scripted-bridge.ts";

/** The lines that end the first execution of `launched` with the answer `FIRST`. */
const firstExecutionEnds = [
  event("session.tool.success", { id: "call_1", content: [{ type: "text", text: "done" }] }),
  event("session.text.ended", { text: "FIRST" }),
  event("session.step.ended"),
  event("session.usage.updated", { cost: 0.01, tokens: tokens(100, 10) }),
  event("session.execution.succeeded"),
];

/** The info of shell `id` that `session` started. */
const shell = (id: string, session: string) => ({
  id,
  status: "running",
  command: "pnpm test",
  cwd: "/work/checkout",
  shell: "/usr/bin/bash",
  file: `/tmp/${id}.out`,
  metadata: { sessionID: session },
  time: { started: 0 },
});

describe("OpenCode turn", () => {
  for (const limit of [Option.none<number>(), Option.some(10)])
    it.effect(
      `returns the answer after background work ends without waking the root, limit ${Option.getOrElse(limit, () => 0)}`,
      () =>
        Effect.gen(function* () {
          const { bridge, running, until } = yield* launched(
            "Started the tests.",
            ChildRequest.make({ ...childRequest, maxBackgroundWaitMinutes: limit }),
          );
          for (const line of [
            { event: { type: "shell.created", data: { info: shell("sh_1", SESSION) } } },
            ...firstExecutionEnds,
          ])
            yield* bridge.emit(line);
          yield* until("BackgroundWorkUpdated");
          yield* bridge.emit({
            event: { type: "shell.exited", data: { id: "sh_1", exit: 0, status: "exited" } },
          });
          const result = yield* Effect.forkScoped(running.result);
          for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
          yield* TestClock.adjust("30 minutes");
          for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
          const polled = yield* Effect.sync(() => result.pollUnsafe());
          assert(polled !== undefined, "the session returned after the work ended");
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
