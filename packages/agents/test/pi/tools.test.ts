// The fake Pi session runs its tools through the SDK's Promise callbacks.
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, RoleName, RoleSession } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { AdmissionContext, AdmittedBrain } from "../../src/harness/admission.ts";
import { continuationPolicy } from "../../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../../src/harness/contract.ts";
import { piRuntime } from "../../src/harness/pi/pi.ts";
import {
  PiSdk,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
} from "../../src/harness/pi/sdk.ts";
import { RolePlacements, RoleSpec } from "../../src/harness/role.ts";
import { RestartState, WorkingDirectory } from "../../src/runtime.ts";

// A usine tool that takes the name of Pi's own `read` tool, which Pi can't carry.
const Read = Tool.make("read", {
  description: "Reads a usine note.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
});
const tools = Toolkit.make(Read);
const handlers = tools.toLayer({ read: ({ name }) => Effect.succeed(`note ${name}`) });

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
  harness: Harness.make("pi"),
  model: ModelId.make("openai/gpt-5.6-luna"),
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
  cwd: WorkingDirectory.make("/tmp/usine-pi-tools"),
  environment: {},
});

/**
 * Opens a session that serves `kit` on a fake Pi, whose prompt runs `turn` with the start options
 * and a publisher of session events, and returns the session's events.
 */
const runPi = <Tools extends Record<string, Tool.Any>, R>(
  kit: Toolkit.Toolkit<Tools>,
  handlers: Layer.Layer<R>,
  turn: (options: PiStartOptions, publish: (event: PiSessionEvent) => void) => Promise<void>,
) => {
  let options: PiStartOptions | undefined;
  const listeners: Array<(event: PiSessionEvent) => void> = [];
  const publish = (event: PiSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  const session: PiSession = {
    abort: () => Promise.resolve(),
    dispose: () => undefined,
    messages: [],
    prompt: async () => {
      assert(options !== undefined);
      await turn(options, publish);
      publish({ type: "message_end", message: fauxAssistantMessage("done") });
    },
    steer: () => Promise.resolve(),
    subscribe: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
  };
  const sdk = Layer.succeed(PiSdk)({
    start: (found) => {
      options = found;
      return Promise.resolve({
        _tag: "Started",
        harnessSession: Option.none(),
        model: brain.model,
        pool: "apiKeys",
        session,
        tools: found.hostTools.map(({ name }) => name),
      });
    },
  });
  return Effect.gen(function* () {
    const runtime = yield* piRuntime;
    const policy = yield* continuationPolicy(spec, "Read the note", RestartState.make({}));
    const native = yield* runtime.open(
      spec,
      StartPrompt.make({ text: "Read the note" }),
      policy,
      kit,
    );
    const events = yield* Stream.runCollect(native.running.events);
    assert(options !== undefined);
    return { options, events };
  }).pipe(Effect.scoped, Effect.provide([sdk, handlers, NodeServices.layer]));
};

// SAFETY: a usine tool reads nothing from Pi's tool context.
const toolContext = {} as ExtensionToolContext;

describe("Pi usine tool sets", () => {
  it.effect("list only the toolkit's tools and report them under the toolkit's names", () =>
    Effect.gen(function* () {
      const { options, events } = yield* runPi(tools, handlers, async (options, publish) => {
        const definition = options.hostTools[0];
        assert(definition !== undefined);
        publish({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: definition.name,
          args: { name: "greeting" },
        });
        const result = await definition.execute(
          "call-1",
          { name: "greeting" },
          undefined,
          undefined,
          toolContext,
        );
        publish({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: definition.name,
          result,
          isError: result.isError === true,
        });
      });
      assert.strictEqual(options.nativeTools, false);
      const alias = options.hostTools[0]?.name;
      assert(alias !== undefined);
      assert.notStrictEqual(alias, "read", "the alias keeps Pi's own read tool name free");
      assert.match(alias, /^read_/);
      const calls = events.flatMap((event) =>
        event._tag === "ToolStarted" || event._tag === "ToolFinished" ? [event] : [],
      );
      assert.deepStrictEqual(
        calls.map((event) => [event._tag, event.tool]),
        [
          ["ToolStarted", "read"],
          ["ToolFinished", "read"],
        ],
      );
      const finished = calls[1];
      assert(finished?._tag === "ToolFinished");
      assert.isFalse(finished.isError);
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
        finished.output,
      );
      assert.include(output, "note greeting");
    }),
  );

  it.effect("interrupt the handler of a call that Pi cancels", () => {
    const Wait = Tool.make("wait", { description: "Waits until the call is cancelled." });
    const kit = Toolkit.make(Wait);
    let interrupted = false;
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waitHandlers = kit.toLayer({
      wait: () =>
        Effect.sync(() => started()).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
    });
    let cancelled: "rejected" | "resolved" | "pending" | undefined;
    return Effect.gen(function* () {
      yield* runPi(kit, waitHandlers, async (options) => {
        const definition = options.hostTools[0];
        assert(definition !== undefined);
        const controller = new AbortController();
        const call = definition.execute("call-1", {}, controller.signal, undefined, toolContext);
        await waiting;
        controller.abort();
        cancelled = await Promise.race([
          call.then(
            () => "resolved" as const,
            () => "rejected" as const,
          ),
          // The SDK awaits the call as a Promise, so the test bounds the wait the same way.
          // @effect-diagnostics-next-line globalTimers:off
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 2_000)),
        ]);
      });
      assert.strictEqual(cancelled, "rejected", "a cancelled call rejects");
      assert.isTrue(interrupted, "cancelling a call interrupts its handler");
    });
  });
});
