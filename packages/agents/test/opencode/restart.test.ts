import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { RemoteShell } from "../../src/child-host/child-host.ts";
import { ChildProcessLost } from "../../src/child-host/process.ts";
import { CONTINUATION_MESSAGE } from "../../src/harness/continuation.ts";
import { ChildRequest, SessionOperationError } from "../../src/runtime.ts";
import {
  assertPrompt,
  childRequest,
  event,
  execution,
  launched,
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
