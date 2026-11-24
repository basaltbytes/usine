import { assert, describe, it } from "@effect/vitest";
import { Steer } from "@usine/core/attempt/channel";
import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { ChildRequest } from "../../src/runtime.ts";
import {
  assertPrompt,
  childRequest,
  event,
  execution,
  launched,
  SESSION,
  tokens,
} from "./scripted-bridge.ts";

const CHILD = "ses_child";

/** The lines that end the first execution of `launched` with the answer `FIRST`. */
const firstExecutionEnds = [
  event("session.tool.success", { id: "call_1", content: [{ type: "text", text: "done" }] }),
  event("session.text.ended", { text: "FIRST" }),
  event("session.step.ended"),
  event("session.usage.updated", { cost: 0.01, tokens: tokens(100, 10) }),
  event("session.execution.succeeded"),
];

/** The lines of the execution that a notice `notice` of background work wakes, answering `WOKEN`. */
const woken = (notice: string) => [
  event("session.inbox.enqueued", { inboxID: notice }),
  ...execution(notice, "WOKEN"),
];

describe("OpenCode answer", () => {
  it.live("recounts a steer posted while the success handler reads running jobs", () =>
    Effect.gen(function* () {
      const { bridge, running, seen, ended } = yield* launched("OLD");
      yield* bridge.holdNextJobs;
      for (const line of firstExecutionEnds) yield* bridge.emit(line);
      const jobs = yield* bridge.request;
      assert(jobs.path.startsWith("/api/experimental/job"));
      const guidance = Steer.make({ message: "Reply STEERED instead." });
      const steering = yield* Effect.forkScoped(running.intervene(guidance, () => Effect.void));
      const posted = yield* bridge.request;
      const id = assertPrompt(posted, guidance.message);
      assert(Option.isSome(id));
      yield* bridge.reply(posted, 200, { data: { id: id.value } });
      yield* Fiber.join(steering);
      for (const line of execution(id.value, "STEERED")) yield* bridge.emit(line);
      yield* bridge.reply(jobs, 200, { data: [] });
      const result = yield* running.result;
      yield* ended;
      assert.strictEqual(result.message, "STEERED");
      assert(
        seen.some(
          (value) => value._tag === "OperatorMessageRead" && value.messageId === guidance.id,
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("answers with the steer that the execution's end delivers, read ahead", () =>
    Effect.gen(function* () {
      const { bridge, running, seen, ended } = yield* launched("OLD");
      const guidance = Steer.make({ message: "Reply STEERED instead." });
      const steering = yield* Effect.forkScoped(running.intervene(guidance, () => Effect.void));
      const posted = yield* bridge.request;
      const id = assertPrompt(posted, guidance.message);
      assert(Option.isSome(id));
      // OpenCode delivers the steer in the execution that its end starts, before the runtime
      // handles the old execution's success.
      for (const line of [
        ...firstExecutionEnds,
        event("session.inbox.enqueued", { inboxID: id.value }),
        ...execution(id.value, "STEERED"),
      ])
        yield* bridge.emit(line);
      yield* bridge.reply(posted, 200, { data: { id: id.value } });
      yield* Fiber.join(steering);
      const result = yield* running.result;
      yield* ended;
      assert.strictEqual(result.message, "STEERED");
      assert(
        seen.some(
          (value) => value._tag === "OperatorMessageRead" && value.messageId === guidance.id,
        ),
        "the session reports the steer as read",
      );
    }).pipe(Effect.scoped),
  );

  it.live("answers with the execution that a background shell wakes, read ahead", () =>
    Effect.gen(function* () {
      const { bridge, running, ended, seen } = yield* launched("Started the tests.");
      for (const line of [
        { event: { type: "shell.created", data: { info: shell("sh_1", SESSION) } } },
        ...firstExecutionEnds,
        { event: { type: "shell.exited", data: { id: "sh_1", exit: 0, status: "exited" } } },
        ...woken("msg_notice"),
      ])
        yield* bridge.emit(line);
      const result = yield* running.result;
      yield* ended;
      assert.strictEqual(result.message, "WOKEN");
      const reported = seen.flatMap((value) =>
        value._tag === "BackgroundWorkUpdated" ? [value.work] : [],
      );
      assert.deepStrictEqual(
        Option.map(reported[0] ?? Option.none(), (work) => work.map(({ id }) => id)),
        Option.some(["sh_1"]),
      );
    }).pipe(Effect.scoped),
  );

  it.live("answers with the execution that a subagent wakes and counts the subagent's tokens", () =>
    Effect.gen(function* () {
      const { bridge, running, ended, seen } = yield* launched("Started a subagent.");
      for (const line of [
        event("session.created", { sessionID: CHILD, parentID: SESSION, title: "review" }),
        event("session.execution.started", { sessionID: CHILD }),
        ...firstExecutionEnds,
        event("session.usage.updated", { sessionID: CHILD, cost: 0.02, tokens: tokens(200, 20) }),
        // Another tree's session doesn't count.
        event("session.usage.updated", { sessionID: "ses_other", cost: 9, tokens: tokens(9, 9) }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        ...woken("msg_notice"),
      ])
        yield* bridge.emit(line);
      const result = yield* running.result;
      yield* ended;
      assert.strictEqual(result.message, "WOKEN");
      const usage = seen.flatMap((value) => (value._tag === "SessionTokensUpdated" ? [value] : []));
      assert.strictEqual(usage.at(-1)?.totalTokens, 330);
      assert.deepStrictEqual(usage.at(-1)?.costUsd, Option.some(0.03));
      const environments = yield* bridge.environments;
      assert.deepStrictEqual(environments, [SESSION, CHILD]);
    }).pipe(Effect.scoped),
  );

  it.live("waits for a notice that OpenCode queued before the execution succeeded", () =>
    Effect.gen(function* () {
      const { bridge, running, ended } = yield* launched("Started the tests.");
      for (const line of [
        event("session.inbox.enqueued", { inboxID: "msg_notice" }),
        ...firstExecutionEnds,
        ...execution("msg_notice", "WOKEN"),
      ])
        yield* bridge.emit(line);
      const result = yield* running.result;
      yield* ended;
      assert.strictEqual(result.message, "WOKEN");
    }).pipe(Effect.scoped),
  );

  for (const listed of ["a job", "an inbox item", "an active execution"] as const)
    it.live(`waits while OpenCode lists ${listed} that no handled event reported`, () =>
      Effect.gen(function* () {
        const { bridge, running, ended } = yield* launched("Started the tests.");
        if (listed === "a job")
          yield* bridge.setJobs([{ kind: "shell", id: "sh_1", status: "running", title: "test" }]);
        if (listed === "an inbox item") yield* bridge.setInbox([{ id: "msg_notice" }]);
        if (listed === "an active execution") yield* bridge.setActive([SESSION]);
        for (const line of firstExecutionEnds) yield* bridge.emit(line);
        const early = yield* running.result.pipe(Effect.timeoutOption("200 millis"));
        assert(Option.isNone(early), "the first execution's answer isn't the result");
        yield* bridge.setJobs([]);
        yield* bridge.setInbox([]);
        yield* bridge.setActive([]);
        for (const line of woken("msg_notice")) yield* bridge.emit(line);
        const result = yield* running.result;
        yield* ended;
        assert.strictEqual(result.message, "WOKEN");
      }).pipe(Effect.scoped),
    );

  it.live("answers when the steer that the answer waited for fails", () =>
    Effect.gen(function* () {
      const { bridge, running } = yield* launched("OLD");
      const steering = yield* Effect.forkScoped(running.steer("Reply STEERED instead."));
      const posted = yield* bridge.request;
      for (const line of firstExecutionEnds) yield* bridge.emit(line);
      const early = yield* running.result.pipe(Effect.timeoutOption("200 millis"));
      assert(Option.isNone(early), "the answer waits for the steer");
      yield* bridge.reply(posted, 500, { message: "The session can't take input" });
      yield* Fiber.join(steering).pipe(Effect.flip);
      const result = yield* running.result;
      assert.strictEqual(result.message, "FIRST");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps waiting through the execution that background work starts", () =>
    Effect.gen(function* () {
      const request = ChildRequest.make({
        ...childRequest,
        maxBackgroundWaitMinutes: Option.some(1),
      });
      const { bridge, running, until } = yield* launched("Started the tests.", request);
      for (const line of [
        { event: { type: "shell.created", data: { info: shell("sh_1", SESSION) } } },
        ...firstExecutionEnds,
      ])
        yield* bridge.emit(line);
      yield* until("BackgroundWorkUpdated");
      for (const line of [
        { event: { type: "shell.exited", data: { id: "sh_1", exit: 0, status: "exited" } } },
        event("session.inbox.enqueued", { inboxID: "msg_notice" }),
        event("session.execution.started"),
        event("session.inbox.delivered", { inboxID: "msg_notice" }),
        event("session.text.ended", { text: "WOKEN" }),
        event("session.tool.input.started", { id: "call_2", name: "shell" }),
        event("session.tool.called", { id: "call_2", input: { command: "pnpm lint" } }),
      ])
        yield* bridge.emit(line);
      yield* until("ToolStarted");
      // The woken execution outlasts the wait limit of the first answer.
      yield* TestClock.adjust("2 minutes");
      for (const line of [
        event("session.tool.success", { id: "call_2", content: [{ type: "text", text: "ok" }] }),
        event("session.text.ended", { text: "WOKEN" }),
        event("session.step.ended"),
        event("session.execution.succeeded"),
      ])
        yield* bridge.emit(line);
      const result = yield* running.result;
      assert.strictEqual(result.message, "WOKEN");
    }).pipe(Effect.scoped),
  );
});

/** Returns the `info` of a running shell that session `session` started. */
function shell(id: string, session: string) {
  return {
    id,
    status: "running",
    command: "pnpm test",
    cwd: "/work/checkout",
    shell: "/usr/bin/bash",
    file: `/tmp/${id}.out`,
    metadata: { sessionID: session },
    time: { started: 0 },
  };
}
