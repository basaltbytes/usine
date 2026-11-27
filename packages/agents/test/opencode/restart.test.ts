import { assert, describe, it } from "@effect/vitest";
import {
  type AgentSessionEvent,
  HarnessSession,
  HarnessSessionId,
} from "@usine/core/agent/session";
import { Steer } from "@usine/core/attempt/channel";
import { Effect, Fiber, type Layer, Option, Stream } from "effect";
import { RemoteShell } from "../../src/child-host/child-host.ts";
import { ChildProcessLost } from "../../src/child-host/process.ts";
import { CONTINUATION_MESSAGE } from "../../src/harness/continuation.ts";
import { openCodeMessageId } from "../../src/harness/opencode/codec.ts";
import type { OpenCodeServer } from "../../src/harness/opencode/server.ts";
import { ChildBackend, ChildRequest, SessionOperationError } from "../../src/runtime.ts";
import {
  assertPrompt,
  childRequest,
  event,
  execution,
  launched,
  type ScriptedBridge,
  scriptedBackend,
  scriptedServer,
  scriptedServerWith,
  SESSION,
  tokens,
} from "./scripted-bridge.ts";

const remoteRequest = ChildRequest.make({
  ...childRequest,
  host: RemoteShell.make({
    ssh: { command: "ssh", args: [] },
    sshEnvironment: {},
    destination: "scripted.worker",
  }),
});

const lost = SessionOperationError.make({
  operation: "stream",
  sessionId: Option.some(childRequest.session.id),
  message: "The OpenCode bridge exited with code 137: killed",
  cause: ChildProcessLost.make({ exitCode: 137, stderrTail: "killed" }),
});

/** The lines that end the first execution while a background shell runs. */
const answeredWithBackground = [
  {
    event: {
      type: "shell.created",
      data: {
        info: { id: "sh_1", command: "pnpm test", metadata: { sessionID: SESSION } },
      },
    },
  },
  event("session.tool.success", { id: "call_1", content: [{ type: "text", text: "done" }] }),
  event("session.text.ended", { text: "FIRST" }),
  event("session.step.ended"),
  event("session.usage.updated", { cost: 0.01, tokens: tokens(100, 10) }),
  event("session.execution.succeeded"),
];

/** A remote request that resumes the scripted session with `guidance` restored as unread. */
const resumed = (guidance: Steer) =>
  ChildRequest.make({
    ...remoteRequest,
    resume: Option.some(
      HarnessSession.make({
        id: HarnessSessionId.make(SESSION),
        cwd: remoteRequest.cwd,
        home: Option.some("/work/opencode"),
      }),
    ),
    unread: [{ id: guidance.id, message: guidance.message }],
  });

/** Launches `resumed(guidance)` over `server` in a scoped fiber. */
const launchResumed = (server: Layer.Layer<OpenCodeServer>, guidance: Steer) =>
  Effect.gen(function* () {
    const backend = yield* ChildBackend;
    return yield* backend.launch(resumed(guidance));
  }).pipe(Effect.provide(scriptedBackend(server)), Effect.forkScoped);

/** Answers the runtime's lookup of the restored steer with `status`, and returns its input ID. */
const restoredLookup = (bridge: ScriptedBridge, status: number) =>
  Effect.gen(function* () {
    const lookup = yield* bridge.request;
    assert.strictEqual(lookup.method, "GET");
    const prefix = `/api/session/${SESSION}/message/`;
    assert(lookup.path.startsWith(prefix), `${lookup.path} looks up a message`);
    const inputId = lookup.path.slice(prefix.length);
    yield* bridge.reply(
      lookup,
      status,
      status === 200 ? { data: { id: inputId, type: "user" } } : { message: "Message not found" },
    );
    return inputId;
  });

/** Asserts that the session reported reading `guidance` once. */
const assertReadOnce = (seen: ReadonlyArray<AgentSessionEvent>, guidance: Steer) =>
  assert.strictEqual(
    seen.filter((value) => value._tag === "OperatorMessageRead" && value.messageId === guidance.id)
      .length,
    1,
  );

describe("OpenCode restart", () => {
  for (const delivery of ["delivered", "pending", "lookup failed"] as const)
    it.live(`reconciles an unread steer after a remote restart: ${delivery}`, () =>
      Effect.gen(function* () {
        const { server, bridge, running, seen, ended } = yield* launched("OLD", remoteRequest);
        const guidance = Steer.make({ message: "Reply STEERED instead." });
        const deliveries: Array<boolean> = [];
        const steering = yield* Effect.forkScoped(
          running.intervene(guidance, (receipt) =>
            Effect.sync(() => deliveries.push(Option.isSome(receipt))),
          ),
        );
        const posted = yield* bridge.request;
        const id = assertPrompt(posted, guidance.message);
        assert(Option.isSome(id));
        yield* bridge.reply(posted, 200, { data: { id: id.value } });
        yield* Fiber.join(steering);
        // The bridge loses the delivery event, so the conversation still considers it unread.
        yield* server.bridges;
        yield* bridge.lose(lost);
        const reopened = yield* server.bridges;
        const continued = yield* reopened.request;
        assertPrompt(continued, CONTINUATION_MESSAGE);
        yield* reopened.reply(continued, 200, { data: { id: "msg_continue" } });
        const resent = yield* reopened.request;
        assert.deepStrictEqual(assertPrompt(resent, guidance.message), id);
        yield* reopened.reply(resent, 200, { data: { id: id.value } });
        const lookup = yield* reopened.request;
        assert.strictEqual(lookup.method, "GET");
        assert.strictEqual(lookup.path, `/api/session/${SESSION}/message/${id.value}`);
        yield* reopened.reply(
          lookup,
          delivery === "delivered" ? 200 : delivery === "pending" ? 404 : 500,
          delivery === "delivered"
            ? { data: { id: id.value, type: "user", text: guidance.message } }
            : { message: "Message unavailable" },
        );
        if (delivery === "lookup failed") {
          const error = yield* running.result.pipe(Effect.flip);
          assert.strictEqual(error._tag, "SessionOperationError");
          assert.include(error.message, "status 500");
          assert.deepStrictEqual(deliveries, []);
          return;
        }
        for (const line of execution("msg_continue", "CONTINUED")) yield* reopened.emit(line);
        if (delivery === "pending") {
          const early = yield* running.result.pipe(Effect.timeoutOption("200 millis"));
          assert(Option.isNone(early), "undelivered guidance still requires its execution");
          assert.deepStrictEqual(deliveries, []);
          for (const line of execution(id.value, "STEERED")) yield* reopened.emit(line);
        }
        const result = yield* running.result;
        yield* ended;
        assert.strictEqual(result.message, delivery === "delivered" ? "CONTINUED" : "STEERED");
        assert.deepStrictEqual(deliveries, [true]);
        assert.strictEqual(
          seen.filter(
            (value) => value._tag === "OperatorMessageRead" && value.messageId === guidance.id,
          ).length,
          1,
        );
      }).pipe(Effect.scoped),
    );

  it.live("acknowledges a delivered steer restored from the journal on resume", () =>
    Effect.gen(function* () {
      const guidance = Steer.make({ message: "Reply STEERED instead." });
      const server = yield* scriptedServer;
      const launching = yield* launchResumed(server.layer, guidance);
      const bridge = yield* server.bridge;
      assert.strictEqual(bridge.target.transport, "resume");
      const continued = yield* bridge.request;
      assertPrompt(continued, CONTINUATION_MESSAGE);
      yield* bridge.reply(continued, 200, { data: { id: "msg_continue" } });
      const resent = yield* bridge.request;
      const id = assertPrompt(resent, guidance.message);
      assert(Option.isSome(id));
      yield* bridge.reply(resent, 200, { data: { id: id.value } });
      const lookup = yield* bridge.request;
      assert.strictEqual(lookup.path, `/api/session/${SESSION}/message/${id.value}`);
      yield* bridge.reply(lookup, 200, { data: { id: id.value, type: "user" } });
      const running = yield* Fiber.join(launching);
      for (const line of execution("msg_continue", "RESUMED")) yield* bridge.emit(line);
      const result = yield* running.result;
      assert.strictEqual(result.message, "RESUMED");
      const seen = yield* Stream.runCollect(running.events);
      assertReadOnce(seen, guidance);
    }).pipe(Effect.scoped),
  );

  for (const status of ["delivered", "lost"] as const)
    it.live(`reconciles a restored steer with an idle retained bridge: ${status}`, () =>
      Effect.gen(function* () {
        const guidance = Steer.make({ message: "Reply STEERED instead." });
        const server = yield* scriptedServerWith({ retained: true });
        const launching = yield* launchResumed(server.layer, guidance);
        const bridge = yield* server.bridge;
        const inputId = yield* restoredLookup(bridge, status === "delivered" ? 200 : 404);
        const continued = yield* bridge.request;
        assertPrompt(continued, CONTINUATION_MESSAGE);
        yield* bridge.reply(continued, 200, { data: { id: "msg_continue" } });
        if (status === "lost") {
          const resent = yield* bridge.request;
          assert.deepStrictEqual(assertPrompt(resent, guidance.message), Option.some(inputId));
          yield* bridge.reply(resent, 200, { data: { id: inputId } });
          const again = yield* bridge.request;
          assert.strictEqual(again.path, `/api/session/${SESSION}/message/${inputId}`);
          yield* bridge.reply(again, 404, { message: "Message not found" });
        }
        const running = yield* Fiber.join(launching);
        for (const line of execution("msg_continue", "RESUMED")) yield* bridge.emit(line);
        if (status === "lost") {
          const early = yield* running.result.pipe(Effect.timeoutOption("200 millis"));
          assert(Option.isNone(early), "the resent steer still requires its execution");
          for (const line of execution(inputId, "STEERED")) yield* bridge.emit(line);
        }
        const result = yield* running.result;
        assert.strictEqual(result.message, status === "delivered" ? "RESUMED" : "STEERED");
        const seen = yield* Stream.runCollect(running.events);
        assertReadOnce(seen, guidance);
      }).pipe(Effect.scoped),
    );

  for (const status of ["delivered", "queued", "lost"] as const)
    it.live(`reconciles a restored steer with a running retained bridge: ${status}`, () =>
      Effect.gen(function* () {
        const guidance = Steer.make({ message: "Reply STEERED instead." });
        const inputId = openCodeMessageId(childRequest.session.id, guidance.id);
        const server = yield* scriptedServerWith({
          retained: true,
          active: [SESSION],
          inbox: status === "queued" ? [{ id: inputId }] : [],
        });
        const launching = yield* launchResumed(server.layer, guidance);
        const bridge = yield* server.bridge;
        if (status !== "queued") {
          const looked = yield* restoredLookup(bridge, status === "delivered" ? 200 : 404);
          assert.strictEqual(looked, inputId);
        }
        if (status === "lost") {
          const resent = yield* bridge.request;
          assert.deepStrictEqual(assertPrompt(resent, guidance.message), Option.some(inputId));
          yield* bridge.reply(resent, 200, { data: { id: inputId } });
        }
        const running = yield* Fiber.join(launching);
        yield* bridge.setActive([]);
        yield* bridge.setInbox([]);
        for (const line of [
          ...(status === "delivered"
            ? []
            : [event("session.inbox.delivered", { inboxID: inputId })]),
          event("session.text.ended", { text: "STEERED" }),
          event("session.step.ended"),
          event("session.execution.succeeded"),
        ])
          yield* bridge.emit(line);
        const result = yield* running.result;
        assert.strictEqual(result.message, "STEERED");
        const seen = yield* Stream.runCollect(running.events);
        assertReadOnce(seen, guidance);
      }).pipe(Effect.scoped),
    );

  it.live(
    "resends a lost steer before the operator's next message to a paused running bridge",
    () =>
      Effect.gen(function* () {
        const guidance = Steer.make({ message: "Reply STEERED instead." });
        const inputId = openCodeMessageId(childRequest.session.id, guidance.id);
        const server = yield* scriptedServerWith({ retained: true, active: [SESSION] });
        const launching = yield* Effect.gen(function* () {
          const backend = yield* ChildBackend;
          return yield* backend.launch(ChildRequest.make({ ...resumed(guidance), paused: true }));
        }).pipe(Effect.provide(scriptedBackend(server.layer)), Effect.forkScoped);
        const bridge = yield* server.bridge;
        const looked = yield* restoredLookup(bridge, 404);
        assert.strictEqual(looked, inputId);
        const running = yield* Fiber.join(launching);
        const early = yield* bridge.request.pipe(Effect.timeoutOption("200 millis"));
        assert(Option.isNone(early), "the paused session doesn't resend the steer at once");
        const next = Steer.make({ message: "Then reply NEXT." });
        const steering = yield* Effect.forkScoped(running.intervene(next, () => Effect.void));
        const resent = yield* bridge.request;
        assert.deepStrictEqual(assertPrompt(resent, guidance.message), Option.some(inputId));
        yield* bridge.reply(resent, 200, { data: { id: inputId } });
        const posted = yield* bridge.request;
        const nextId = assertPrompt(posted, next.message);
        assert(Option.isSome(nextId));
        yield* bridge.reply(posted, 200, { data: { id: nextId.value } });
        yield* Fiber.join(steering);
      }).pipe(Effect.scoped),
  );

  it.live("checks no background work after a restart until an execution succeeds", () =>
    Effect.gen(function* () {
      const { server, bridge, running, until } = yield* launched("OLD", remoteRequest);
      for (const line of answeredWithBackground) yield* bridge.emit(line);
      yield* until("BackgroundWorkUpdated");
      const first = yield* server.bridges;
      assert.strictEqual(first, bridge);
      yield* bridge.lose(lost);
      const reopened = yield* server.bridges;
      const continued = yield* reopened.request;
      assertPrompt(continued, CONTINUATION_MESSAGE);
      yield* reopened.reply(continued, 200, { data: { id: "msg_continue" } });
      // The earlier process's shell stopped with it, so the answer no longer waits for it.
      yield* reopened.emit({
        event: { type: "shell.exited", data: { id: "sh_1", exit: 0, status: "exited" } },
      });
      yield* Effect.sleep("200 millis");
      const answered = yield* reopened.answered;
      assert(
        !answered.some(({ path }) => path.startsWith("/api/experimental/job")),
        "the end of the earlier process's work checks nothing",
      );
      for (const line of [
        event("session.inbox.enqueued", { inboxID: "msg_continue" }),
        ...execution("msg_continue", "AFTER"),
      ])
        yield* reopened.emit(line);
      const result = yield* running.result;
      assert.strictEqual(result.message, "AFTER");
    }).pipe(Effect.scoped),
  );

  it.live("reopens the saved session on a new remote bridge and continues it", () =>
    Effect.gen(function* () {
      const { server, bridge, running, until, seen } = yield* launched("OLD", remoteRequest);
      for (const line of answeredWithBackground) yield* bridge.emit(line);
      const waiting = yield* until("BackgroundWorkUpdated");
      assert(waiting._tag === "BackgroundWorkUpdated");
      assert(Option.isSome(waiting.work));
      const first = yield* server.bridges;
      assert.strictEqual(first, bridge);
      yield* bridge.lose(lost);
      const reopened = yield* server.bridges;
      assert.strictEqual(reopened.target.transport, "replace");
      const continued = yield* reopened.request;
      assertPrompt(continued, CONTINUATION_MESSAGE);
      const environments = yield* reopened.environments;
      assert.deepStrictEqual(environments, [SESSION]);
      yield* reopened.reply(continued, 200, { data: { id: "msg_continue" } });
      for (const line of [
        event("session.inbox.enqueued", { inboxID: "msg_continue" }),
        ...execution("msg_continue", "AFTER"),
      ])
        yield* reopened.emit(line);
      const result = yield* running.result;
      assert.strictEqual(result.message, "AFTER");
      const background = seen.flatMap((value) =>
        value._tag === "BackgroundWorkUpdated" ? [value.work] : [],
      );
      assert(
        background.some(Option.isNone),
        "the restart reports the earlier process's background work as unknown",
      );
    }).pipe(Effect.scoped),
  );

  it.live("fails the session when a local bridge stops", () =>
    Effect.gen(function* () {
      const { bridge, running } = yield* launched("OLD");
      yield* bridge.lose(lost);
      const failure = yield* running.result.pipe(Effect.flip);
      assert(failure._tag === "SessionOperationError");
      assert.strictEqual(failure.message, lost.message);
    }).pipe(Effect.scoped),
  );
});
