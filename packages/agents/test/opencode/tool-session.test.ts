import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { type AgentSessionEvent, RoleName, RoleSession } from "@usine/core/agent/session";
import { Effect, Fiber, Option, Queue, Result, Schema, Stream } from "effect";
import { RemoteShell } from "../../src/child-host/child-host.ts";
import { ChildProcessLost } from "../../src/child-host/process.ts";
import { admitBrain, AdmissionContext } from "../../src/harness/admission.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { continuationPolicy } from "../../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../../src/harness/contract.ts";
import type {
  BridgeMcpConnect,
  BridgeMcpMessage,
} from "../../src/harness/opencode/bridge/lines.ts";
import { openCodeRuntime } from "../../src/harness/opencode/opencode.ts";
import { RolePlacements, RoleSpec } from "../../src/harness/role.ts";
import { ChildSessionJournal, RestartState, SessionOperationError } from "../../src/runtime.ts";
import { contractToolHandlers, contractTools, NOTE } from "../contract/host-tools.ts";
import {
  assertPrompt,
  childRequest,
  event,
  type ScriptedBridge,
  scriptedServer,
  SESSION,
} from "./scripted-bridge.ts";

const role = RoleSpec.make({
  name: RoleName.make("tool-probe"),
  placement: RolePlacements.make({ placements: ["ssh"], reason: "The probe runs over SSH" }),
  credential: Option.none(),
  nativeTools: "read",
  hostTools: true,
  persistence: "saved",
  interventions: true,
  output: "text",
});

const host = RemoteShell.make({
  ssh: { command: "ssh", args: [] },
  sshEnvironment: {},
  destination: "scripted.worker",
});

const lost = SessionOperationError.make({
  operation: "stream",
  sessionId: Option.some(childRequest.session.id),
  message: "The OpenCode bridge exited with code 137: killed",
  cause: ChildProcessLost.make({ exitCode: 137, stderrTail: "killed" }),
});

const PROMPT = "Read the greeting note.";

/** A spec of the probe role on the scripted worker, admitted by OpenCode's descriptor. */
const spec = () => {
  const session = RoleSession.make({
    id: childRequest.session.id,
    role: role.name,
    agent: childRequest.session.agent,
    brain: childRequest.session.brain,
  });
  const admitted = admitBrain(
    catalog,
    role,
    session.brain,
    AdmissionContext.make({ placement: "ssh", credential: "api-key" }),
  );
  assert(Result.isSuccess(admitted), "OpenCode admits a role with a usine tool set");
  return SessionSpec.make({
    session,
    admitted: admitted.success,
    host,
    worker: childRequest.worker,
    machine: Option.none(),
    cwd: childRequest.cwd,
    environment: childRequest.environment,
  });
};

const isMessage = (line: BridgeMcpConnect | BridgeMcpMessage): line is BridgeMcpMessage =>
  "message" in line;

/** Answers the connect line on `bridge` and OpenCode's start of the tools' server. */
const attachOn = (bridge: ScriptedBridge) =>
  Effect.gen(function* () {
    const connect = yield* bridge.mcp;
    assert(!isMessage(connect), "the runtime connects the tools' server first");
    assert.deepStrictEqual(connect, { id: connect.id, mcp: "usine", directory: childRequest.cwd });
    yield* bridge.reply(connect, 101, null);
    yield* bridge.emit({ mcp: "usine", message: { jsonrpc: "2.0", id: 0, method: "initialize" } });
    yield* bridge.mcp;
    yield* bridge.emit({ mcp: "usine", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    yield* bridge.mcp;
    const ping = yield* bridge.mcp;
    assert(isMessage(ping));
    yield* bridge.emit({
      mcp: "usine",
      message: { jsonrpc: "2.0", id: ping.message.id ?? null, result: {} },
    });
  });

const Permissions = Schema.Struct({
  body: Schema.Struct({
    permissions: Schema.Array(
      Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.String }),
    ),
  }),
});

describe("OpenCode session with usine tools", () => {
  it.live(
    "attaches the tools before the prompt, names them by the toolkit, and reattaches after a restart",
    () =>
      Effect.gen(function* () {
        const server = yield* scriptedServer;
        const opened = yield* Effect.gen(function* () {
          const runtime = yield* openCodeRuntime;
          const opening = spec();
          const policy = yield* continuationPolicy(opening, PROMPT, RestartState.make({}));
          return yield* runtime.open(
            opening,
            StartPrompt.make({ text: PROMPT }),
            policy,
            contractTools,
          );
        }).pipe(
          Effect.provide([
            server.layer,
            contractToolHandlers,
            ChildSessionJournal.layerNoop,
            NodeServices.layer,
          ]),
          Effect.forkScoped,
        );
        const bridge = yield* server.bridges;
        yield* attachOn(bridge);
        const prompt = yield* bridge.request;
        assertPrompt(prompt, PROMPT);
        const created = (yield* bridge.answered).find(
          (request) => request.method === "POST" && request.path === "/api/session",
        );
        const { body } = yield* Schema.decodeUnknownEffect(Permissions)(created);
        assert.deepStrictEqual(
          body.permissions,
          [
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
            { action: "glob", resource: "*", effect: "allow" },
            { action: "grep", resource: "*", effect: "allow" },
            { action: "usine_*", resource: "*", effect: "allow" },
          ],
          "a read role keeps the read tools and its usine tools",
        );
        const environments1 = yield* bridge.environments;
        assert.deepStrictEqual(environments1, [SESSION]);
        yield* bridge.reply(prompt, 200, { data: { id: "msg_prompt" } });
        const { running } = yield* Fiber.join(opened);
        const events = yield* Queue.unbounded<AgentSessionEvent>();
        yield* running.events.pipe(
          Stream.runForEach((value) => Queue.offer(events, value)),
          Effect.ignore,
          Effect.forkScoped,
        );
        /** The next tool event of the session, skipping the others. */
        const nextTool = Effect.gen(function* () {
          for (;;) {
            const next = yield* Queue.take(events);
            if (next._tag === "ToolStarted" || next._tag === "ToolFinished") return next;
          }
        });
        for (const line of [
          event("session.execution.started"),
          event("session.inbox.delivered", { inboxID: "msg_prompt" }),
          event("session.tool.input.started", { id: "call_1", name: "usine_read_note" }),
          event("session.tool.called", { id: "call_1", input: { name: "greeting" } }),
          {
            mcp: "usine",
            message: {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "read_note",
                arguments: { name: "greeting" },
                _meta: { "ai.opencode/sessionID": SESSION },
              },
            },
          },
        ])
          yield* bridge.emit(line);
        const started = yield* nextTool;
        assert.strictEqual(started._tag, "ToolStarted");
        assert.strictEqual(started.tool, "read_note", "events carry the toolkit's name");
        const line1 = yield* bridge.mcp;
        assert.deepStrictEqual(line1, {
          mcp: "usine",
          message: {
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: NOTE }], isError: false },
          },
        });
        yield* bridge.emit(
          event("session.tool.success", {
            id: "call_1",
            content: [{ type: "text", text: NOTE }],
          }),
        );
        const finished = yield* nextTool;
        assert.strictEqual(finished._tag, "ToolFinished");
        assert.strictEqual(finished.tool, "read_note");

        yield* bridge.lose(lost);
        const reopened = yield* server.bridges;
        yield* attachOn(reopened);
        const environments2 = yield* reopened.environments;
        assert.deepStrictEqual(environments2, [SESSION]);
        const continued = yield* reopened.request;
        assert.strictEqual(continued.path, `/api/session/${SESSION}/prompt`);
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  );
});
