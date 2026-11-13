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
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Tool, Toolkit } from "effect/ai";
import { ExecShell, type ExecTransport, LocalProcess } from "../../src/child-host/child-host.ts";
import { AdmissionContext, AdmittedBrain } from "../../src/harness/admission.ts";
import { continuationPolicy } from "../../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../../src/harness/contract.ts";
import { piRuntime } from "../../src/harness/pi/pi.ts";
import {
  PiSdk,
  piSessionTools,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
} from "../../src/harness/pi/sdk.ts";
import { RolePlacements, RoleSpec } from "../../src/harness/role.ts";
import { RestartState, WorkingDirectory } from "../../src/runtime.ts";
import { collectLogs } from "../logs.ts";

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
  nativeTools: "none",
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
  opened: SessionSpec = spec,
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
    complete: () => Promise.reject(new Error("The test runs no completion")),
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
    const policy = yield* continuationPolicy(opened, "Read the note", RestartState.make({}));
    const native = yield* runtime.open(
      opened,
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

const CANCELLED = "Usine tool call was cancelled";

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
      assert.strictEqual(options.nativeTools, "none");
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
    const kit = Toolkit.make(Read, Wait);
    let interrupted = false;
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waitHandlers = kit.toLayer({
      read: ({ name }) => Effect.succeed(`note ${name}`),
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
    const logs = collectLogs(["Info"]);
    return Effect.gen(function* () {
      yield* runPi(kit, waitHandlers, async (options) => {
        const [read, definition] = options.hostTools;
        assert(read !== undefined && definition !== undefined);
        await read.execute("call-0", { name: "greeting" }, undefined, undefined, toolContext);
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
      assert.deepStrictEqual(
        logs.records
          .map(({ message }) => message)
          .filter((message) => Array.isArray(message) && message[0] === CANCELLED),
        [[CANCELLED, { tool: "wait", callId: "call-1" }]],
        "only the cancelled call is logged",
      );
    }).pipe(Effect.provide(logs.layer));
  });

  it.live("run Pi's read and search tools on the session's exec shell host", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "usine-pi-host-" });
      yield* fs.makeDirectory(`${cwd}/acme/demo/docs`, { recursive: true });
      yield* fs.writeFileString(`${cwd}/acme/demo/README.md`, "The needle is here.\n");
      yield* fs.makeDirectory(`${cwd}/acme/demo/src/lib`, { recursive: true });
      yield* fs.writeFileString(`${cwd}/acme/demo/src/lib/a.spec.ts`, "const port = 8080;\n");
      yield* fs.writeFileString(`${cwd}/acme/demo/src/b.ts`, "const port = 8080;\n");
      yield* fs.writeFileString(
        `${cwd}/acme/demo/bundle.min.js`,
        `var needle=1;${"x".repeat(2_000)}\n`,
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const lines: Array<string> = [];
      // Runs each command line with the local shell, as a sandbox's transport runs it in its container.
      const transport: ExecTransport = {
        run: (line, stdin) =>
          Effect.gen(function* () {
            lines.push(line);
            const handle = yield* spawner
              .spawn(ChildProcess.make("sh", ["-c", line], { stdin }))
              .pipe(Effect.orDie);
            return {
              stdout: handle.stdout.pipe(Stream.orDie),
              stderr: handle.stderr.pipe(Stream.orDie),
              exitCode: handle.exitCode.pipe(Effect.orDie, Effect.map(Number)),
            };
          }),
      };
      const reader = RoleSpec.make({ ...role, nativeTools: "read" });
      const sandboxed = SessionSpec.make({
        ...spec,
        admitted: AdmittedBrain.make({ ...spec.admitted, role: reader }),
        host: ExecShell.make({ transport, destination: "supervisor-sandbox" }),
        cwd: WorkingDirectory.make(cwd),
      });
      const outputs: Array<string> = [];
      const { options } = yield* runPi(
        Toolkit.empty,
        Layer.empty,
        async (options) => {
          const listed = piSessionTools(
            options.cwd,
            Option.none(),
            options.nativeTools,
            [],
            options.host,
          );
          const run = async (
            name: string,
            input: Readonly<Record<string, string | number | boolean>>,
          ) => {
            const tool = listed.customTools?.find((definition) => definition.name === name);
            assert(tool !== undefined, name);
            const result = await tool.execute(name, input, undefined, undefined, toolContext);
            outputs.push(
              result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
            );
          };
          await run("read", { path: "acme/demo/README.md" });
          await run("ls", { path: "acme/demo" });
          await run("find", { pattern: "**/*.md" });
          await run("grep", { pattern: "needle" });
          await run("grep", { pattern: "port = \\d+", path: "acme/demo", glob: "*.ts" });
          await run("grep", { pattern: "port = \\d+", path: "acme/demo", glob: "**/*.spec.ts" });
          await run("grep", { pattern: "port = \\d+", path: "acme/demo", glob: "src/**/*.ts" });
          await run("grep", { pattern: "PORT", path: "acme/demo", ignoreCase: true, limit: 1 });
        },
        sandboxed,
      );
      assert.strictEqual(options.nativeTools, "read");
      assert(Option.isSome(options.host), "Pi gets the host's command runner");
      const [read, ls, find, grep, anyTs, specs, underSrc, limited] = outputs;
      assert.include(read, "The needle is here.");
      assert.sameMembers(ls?.split("\n") ?? [], ["README.md", "bundle.min.js", "docs/", "src/"]);
      assert.include(find, "acme/demo/README.md");
      assert.strictEqual(
        grep,
        [
          `acme/demo/README.md:1: The needle is here.`,
          `acme/demo/bundle.min.js:1: var needle=1;${"x".repeat(487)}... [truncated]`,
          "",
          "[Some lines truncated to 500 chars. Use read tool to see full lines]",
        ].join("\n"),
        "a match in a minified file shows 500 characters",
      );
      assert.strictEqual(
        anyTs,
        "src/b.ts:1: const port = 8080;\nsrc/lib/a.spec.ts:1: const port = 8080;",
      );
      assert.strictEqual(specs, "src/lib/a.spec.ts:1: const port = 8080;");
      assert.strictEqual(underSrc, anyTs);
      assert.strictEqual(
        limited,
        "src/b.ts:1: const port = 8080;\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]",
      );
      assert.isNotEmpty(lines);
      for (const line of lines)
        assert.include(line, `cd '${cwd}'`, "each command runs in the session's directory");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
