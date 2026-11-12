// The fake Claude session calls its tool server through the SDK's Promise callbacks.
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, RoleName, RoleSession } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { Effect, Layer, Option, Schema, Semaphore, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { LocalProcess, RemoteShell } from "../src/child-host/child-host.ts";
import { ChildProcessLost } from "../src/child-host/process.ts";
import { AdmissionContext, AdmittedBrain } from "../src/harness/admission.ts";
import { claudeRuntime } from "../src/harness/claude/claude.ts";
import {
  ClaudeSdk,
  type ClaudeQueryOptions,
  type ClaudeToolServer,
} from "../src/harness/claude/sdk.ts";
import { continuationPolicy } from "../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../src/harness/contract.ts";
import { RolePlacements, RoleSpec } from "../src/harness/role.ts";
import { HostLoginLock, RestartState, WorkingDirectory } from "../src/runtime.ts";
import type { HostToolResult } from "../src/harness/tools.ts";
import { collectLogs } from "./logs.ts";

const PREFIX = "mcp__usine__";
const CANCELLED = "Usine tool call was cancelled";
/** A name that fits the API's 64 characters on its own, but not after Claude Code's prefix. */
const LONG = "n".repeat(64 - PREFIX.length + 1);

const note = { parameters: Schema.Struct({ name: Schema.String }), success: Schema.String };
const tools = Toolkit.make(
  Tool.make("notes.read", { description: "Reads a usine note.", ...note }),
  Tool.make(LONG, { description: "Reads a usine note with a long name.", ...note }),
  Tool.make("wait", { description: "Waits until the call is cancelled." }),
);

/** What the fake session saw while it ran. */
interface Observed {
  server?: ClaudeToolServer;
  results: Array<HostToolResult>;
  /** How the call to `wait` ended after its signal aborted. */
  cancelled?: "rejected" | "resolved" | "pending";
  interrupted: boolean;
}

const role = RoleSpec.make({
  name: RoleName.make("decision"),
  placement: RolePlacements.make({ placements: ["local"], reason: "The probe runs locally" }),
  credential: Option.none(),
  nativeTools: false,
  hostTools: true,
  persistence: "saved",
  interventions: false,
  output: "text",
});
const brain = BrainSpec.make({
  harness: Harness.make("claude"),
  model: ModelId.make("claude-sonnet-4-6"),
  effort: "low",
});
const spec = SessionSpec.make({
  session: RoleSession.make({
    id: AgentSessionId.make("decision-1"),
    role: role.name,
    agent: AgentName.make("developer"),
    brain,
  }),
  admitted: AdmittedBrain.make({
    role,
    brain,
    context: AdmissionContext.make({ placement: "local", credential: "host-login" }),
    pool: Option.none(),
  }),
  host: LocalProcess.make(),
  worker: WorkerName.make("local"),
  machine: Option.none(),
  cwd: WorkingDirectory.make("/tmp/usine-claude-tools"),
  environment: { CLAUDE_CONFIG_DIR: "/tmp/usine-claude-tools/.claude" },
});

const loginLock = Layer.effect(
  HostLoginLock,
  Effect.map(Semaphore.make(1), (mutex) =>
    HostLoginLock.of({ withLock: () => (effect) => mutex.withPermit(effect) }),
  ),
);

/**
 * A Claude Code stand-in that calls each listed tool through the session's tool server, cancels a
 * call to `wait`, and then reports one call of the dotted tool under Claude Code's name for it.
 */
const fakeClaude = (observed: Observed, waiting: Promise<void>) =>
  Layer.succeed(ClaudeSdk)({
    open: (_input, _options, server) => ({
      close: () => undefined,
      interrupt: () => Promise.resolve(),
      usesApiKey: () => Promise.resolve(false),
      supportedModels: () =>
        Promise.resolve([{ value: "sonnet", resolvedModel: "claude-sonnet-4-6" }]),
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "claude-tools-1" };
        assert(Option.isSome(server));
        const tools = server.value;
        observed.server = tools;
        const [dotted, long, wait] = tools.tools.map(({ name }) => name);
        assert(dotted !== undefined && long !== undefined && wait !== undefined);
        for (const name of [dotted, long])
          observed.results.push(
            await tools.call(
              name,
              Option.some({ name: "greeting" }),
              Option.some(`toolu_${name}`),
              new AbortController().signal,
            ),
          );
        const controller = new AbortController();
        const call = tools.call(
          wait,
          Option.some({}),
          Option.some("toolu_wait"),
          controller.signal,
        );
        await waiting;
        controller.abort();
        observed.cancelled = await Promise.race([
          call.then(
            () => "resolved" as const,
            () => "rejected" as const,
          ),
          // The SDK awaits the call as a Promise, so the test bounds the wait the same way.
          // @effect-diagnostics-next-line globalTimers:off
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 2_000)),
        ]);
        const callId = "toolu_1";
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: callId, name: `${PREFIX}${dotted}`, input: { name: "a" } },
            ],
          },
        };
        yield {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: callId, content: "note a" }] },
        };
        yield { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } };
        yield { type: "result", subtype: "success", result: "Done." };
      },
    }),
  });

describe("Claude Code usine tool sets", () => {
  it.effect("list aliases that fit Claude Code, run calls by alias, and cancel calls", () => {
    const observed: Observed = { results: [], interrupted: false };
    const logs = collectLogs(["Info"]);
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handlers = tools.toLayer({
      "notes.read": ({ name }) => Effect.succeed(`note ${name}`),
      [LONG]: ({ name }) => Effect.succeed(`long note ${name}`),
      wait: () =>
        Effect.sync(() => started()).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              observed.interrupted = true;
            }),
          ),
        ),
    });
    return Effect.gen(function* () {
      const runtime = yield* claudeRuntime;
      const policy = yield* continuationPolicy(spec, "Read the notes", RestartState.make({}));
      const native = yield* runtime.open(
        spec,
        StartPrompt.make({ text: "Read the notes" }),
        policy,
        tools,
      );
      const events = yield* Stream.runCollect(native.running.events);
      const listed = observed.server?.tools.map(({ name }) => name) ?? [];
      assert.strictEqual(listed.length, 3);
      const [dotted, long] = listed;
      assert(dotted !== undefined && long !== undefined);
      assert.match(dotted, /^notes_read_/, "Claude Code lists the dotted name's alias");
      assert.notStrictEqual(long, LONG, "a name too long with the prefix is aliased");
      for (const name of listed) assert.isAtMost(`${PREFIX}${name}`.length, 64);
      assert.strictEqual(listed[2], "wait");
      assert.deepStrictEqual(observed.results, [
        { isError: false, text: "note greeting" },
        { isError: false, text: "long note greeting" },
      ]);
      assert.strictEqual(observed.cancelled, "rejected", "a cancelled call rejects");
      assert.isTrue(observed.interrupted, "cancelling a call interrupts its handler");
      assert.deepStrictEqual(
        logs.records
          .map(({ message }) => message)
          .filter((message) => Array.isArray(message) && message[0] === CANCELLED),
        [[CANCELLED, { tool: "wait", callId: "toolu_wait" }]],
        "only the cancelled call is logged, with its call ID",
      );
      const calls = events.flatMap((event) =>
        event._tag === "ToolStarted" || event._tag === "ToolFinished" ? [event] : [],
      );
      assert.deepStrictEqual(
        calls.map((event) => [event._tag, event.tool]),
        [
          ["ToolStarted", "notes.read"],
          ["ToolFinished", "notes.read"],
        ],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide([
        fakeClaude(observed, waiting),
        handlers,
        loginLock,
        logs.layer,
        NodeServices.layer,
      ]),
    );
  });

  it.effect("serve the usine tools to the process that resumes a lost remote session", () => {
    const opened: Array<{ options: ClaudeQueryOptions; server: Option.Option<ClaudeToolServer> }> =
      [];
    const results: Array<HostToolResult> = [];
    const remote = SessionSpec.make({
      ...spec,
      host: RemoteShell.make({
        ssh: { command: "ssh", args: [] },
        sshEnvironment: {},
        destination: "worker.example",
      }),
    });
    // The first process stops after its start; the resumed one calls a usine tool and finishes.
    const lostOnce = Layer.succeed(ClaudeSdk)({
      open: (_input, options, server) => {
        opened.push({ options, server });
        const launch = opened.length;
        return {
          close: () => undefined,
          interrupt: () => Promise.resolve(),
          usesApiKey: () => Promise.resolve(false),
          supportedModels: () =>
            Promise.resolve([{ value: "sonnet", resolvedModel: "claude-sonnet-4-6" }]),
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "claude-tools-2" };
            if (launch === 1) throw ChildProcessLost.make({ exitCode: 255, stderrTail: "" });
            assert(Option.isSome(server));
            const dotted = server.value.tools[0]?.name;
            assert(dotted !== undefined);
            results.push(
              await server.value.call(
                dotted,
                Option.some({ name: "greeting" }),
                Option.none(),
                new AbortController().signal,
              ),
            );
            yield { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } };
            yield { type: "result", subtype: "success", result: "Done." };
          },
        };
      },
    });
    const handlers = tools.toLayer({
      "notes.read": ({ name }) => Effect.succeed(`note ${name}`),
      [LONG]: ({ name }) => Effect.succeed(`long note ${name}`),
      wait: () => Effect.never,
    });
    return Effect.gen(function* () {
      const runtime = yield* claudeRuntime;
      const policy = yield* continuationPolicy(remote, "Read the notes", RestartState.make({}));
      const native = yield* runtime.open(
        remote,
        StartPrompt.make({ text: "Read the notes" }),
        policy,
        tools,
      );
      yield* Stream.runDrain(native.running.events);
      assert.lengthOf(opened, 2, "the lost process is relaunched once");
      const [first, second] = opened;
      assert(first !== undefined && second !== undefined);
      assert.isString(second.options.resume, "the relaunch resumes the saved session");
      assert(Option.isSome(first.server) && Option.isSome(second.server));
      assert.deepStrictEqual(
        second.server.value.tools.map(({ name }) => name),
        first.server.value.tools.map(({ name }) => name),
        "the relaunched process lists the same usine tools",
      );
      assert.deepStrictEqual(results, [{ isError: false, text: "note greeting" }]);
    }).pipe(Effect.scoped, Effect.provide([lostOnce, handlers, loginLock, NodeServices.layer]));
  });
});
