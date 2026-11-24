import { assert, describe, it } from "@effect/vitest";
import { HarnessSession, HarnessSessionId } from "@usine/core/agent/session";
import { Steer } from "@usine/core/attempt/channel";
import { Effect, Fiber, Option, Stream } from "effect";
import { RemoteShell } from "../../src/child-host/child-host.ts";
import { ChildProcessLost } from "../../src/child-host/process.ts";
import { CONTINUATION_MESSAGE } from "../../src/harness/continuation.ts";
import { ChildBackend, ChildRequest, SessionOperationError } from "../../src/runtime.ts";
import {
  assertPrompt,
  childRequest,
  event,
  execution,
  launched,
  scriptedBackend,
  scriptedServer,
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
      const request = ChildRequest.make({
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
      const launching = yield* Effect.gen(function* () {
        const backend = yield* ChildBackend;
        return yield* backend.launch(request);
      }).pipe(Effect.provide(scriptedBackend(server.layer)), Effect.forkScoped);
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
      const seen = yield* Stream.runCollect(running.events);
      assert.strictEqual(result.message, "RESUMED");
      assert.strictEqual(
        seen.filter(
          (value) => value._tag === "OperatorMessageRead" && value.messageId === guidance.id,
        ).length,
        1,
      );
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
