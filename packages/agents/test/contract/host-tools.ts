import { assert } from "@effect/vitest";
import { Harness } from "@usine/core/agent/brain";
import {
  type AgentSessionEvent,
  AgentSessionId,
  RoleName,
  RoleSession,
} from "@usine/core/agent/session";
import { type Brand, Effect, Fiber, Layer, Option, Result, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { admitBrain, AdmissionContext } from "../../src/harness/admission.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { claudeRuntime } from "../../src/harness/claude/claude.ts";
import { codexRuntime } from "../../src/harness/codex/codex.ts";
import { continuationPolicy } from "../../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../../src/harness/contract.ts";
import { HarnessCatalog } from "../../src/harness/harness.ts";
import { piRuntime } from "../../src/harness/pi/pi.ts";
import { Harnesses } from "../../src/harness/registry.ts";
import type { HarnessRuntime } from "../../src/harness/runtime.ts";
import { type NativeTools, RolePlacements, RoleSpec } from "../../src/harness/role.ts";
import { RestartState } from "../../src/runtime.ts";
import { openFixture, openPiFixture } from "../replay/fixture.ts";
import type { Transcript } from "../replay/transcript.ts";

/** The harnesses whose adapters serve a usine tool set. */
export const toolProviders = ["claude", "pi", "codex"] as const;
export type ToolProvider = (typeof toolProviders)[number];

/** The scenarios that prove `usine-tools` and `closed-tools`. */
export const toolScenarios = ["host-tool", "closed-tools"] as const;
export type ToolScenario = (typeof toolScenarios)[number];

/**
 * The tool scenarios that `provider`'s adapter passes. Codex lists its own tools in every thread,
 * so its descriptor lacks `closed-tools`.
 */
export const toolScenariosOf = (provider: ToolProvider): ReadonlyArray<ToolScenario> =>
  provider === "codex" ? ["host-tool"] : toolScenarios;

/** The note that `read_note` returns, which the session's answer repeats. */
export const NOTE = "REPLAY_NOTE_7431";

export class NoteMissing extends Schema.TaggedError<
  NoteMissing,
  Brand.Brand<"@usine/agents/test/NoteMissing">
>("@usine/agents/test/NoteMissing")("NoteMissing", { note: Schema.String }) {}

/** The one toolkit that every adapter serves in the contract suite. */
export const ReadNote = Tool.make("read_note", {
  description: "Reads the usine note with the given name.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: NoteMissing,
});
export const contractTools = Toolkit.make(ReadNote);

/** Only the `greeting` note exists; reading any other note fails. */
export const contractToolHandlers = contractTools.toLayer({
  read_note: ({ name }) =>
    name === "greeting" ? Effect.succeed(NOTE) : Effect.fail(NoteMissing.make({ note: name })),
});

const prompts = {
  "host-tool":
    'Call the read_note tool with the name "missing". That call fails. Then call read_note with ' +
    'the name "greeting" and reply with exactly the note that it returns. Call no other tools.',
  "closed-tools":
    'Call the read_note tool with the name "greeting" and reply with exactly the note that it ' +
    "returns.",
} satisfies Record<ToolScenario, string>;

const probe = (nativeTools: NativeTools) =>
  RoleSpec.make({
    name: RoleName.make("contract-probe"),
    placement: RolePlacements.make({
      placements: ["local"],
      reason: "The contract probe runs on the local worker",
    }),
    credential: Option.none(),
    nativeTools,
    hostTools: true,
    persistence: "saved",
    interventions: false,
    output: "text",
  });

const ToolNames = Schema.Array(Schema.Struct({ name: Schema.String }));
/** Pi declares a request's tools in its system messages. */
const PiRequest = Schema.Struct({
  method: Schema.Literal("stream"),
  messages: Schema.Array(Schema.Json),
});
const PiSystemMessage = Schema.Struct({
  role: Schema.Literal("system"),
  toolsAdded: Schema.optionalKey(ToolNames),
});
const ClaudeInit = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  tools: Schema.Array(Schema.String),
});
/** A `thread/start` request that registers client-served tools in namespaces. */
const CodexThreadStart = Schema.Struct({
  method: Schema.Literal("thread/start"),
  params: Schema.Struct({
    dynamicTools: Schema.Array(Schema.Struct({ name: Schema.String, tools: ToolNames })),
  }),
});

/**
 * The tool lists that the recorded traffic shows the session offering to the model: the tools
 * that Pi declares in each provider request, the tools of Claude Code's `init` messages, or the
 * namespaced tools that Codex's `thread/start` registers. Codex's own tools appear only in its
 * model requests, which the app-server traffic doesn't carry.
 */
export const listedTools = (
  provider: ToolProvider,
  entries: Transcript["entries"],
): ReadonlyArray<ReadonlyArray<string>> =>
  entries.flatMap((entry) => {
    if (
      provider === "pi" &&
      entry.type === "expect_outbound" &&
      Schema.is(PiRequest)(entry.payload)
    )
      return [
        entry.payload.messages.flatMap((message) =>
          Schema.is(PiSystemMessage)(message)
            ? (message.toolsAdded ?? []).map(({ name }) => name)
            : [],
        ),
      ];
    if (
      provider === "claude" &&
      entry.type === "emit_inbound" &&
      entry.port.endsWith("/output") &&
      Schema.is(ClaudeInit)(entry.payload)
    )
      return [entry.payload.tools];
    if (
      provider === "codex" &&
      entry.type === "expect_outbound" &&
      entry.port.endsWith("/stdin") &&
      Schema.is(CodexThreadStart)(entry.payload)
    )
      return [
        entry.payload.params.dynamicTools.flatMap((namespace) =>
          namespace.tools.map(({ name }) => `${namespace.name}.${name}`),
        ),
      ];
    return [];
  });

/** The name under which each harness lists the contract tool. */
export const listedName = {
  claude: "mcp__usine__read_note",
  pi: "read_note",
  codex: "usine.read_note",
} satisfies Record<ToolProvider, string>;

/** The harnesses whose recorded tool lists include the harness's own tools. */
export const listsOwnTools: ReadonlySet<ToolProvider> = new Set(["claude", "pi"]);

/** Registers `runtime` alone, with `provider`'s descriptor, so the registry admits each session. */
const registered = <R>(
  provider: ToolProvider,
  runtime: Effect.Effect<HarnessRuntime, never, R>,
) => {
  const descriptor = catalog.get(Harness.make(provider));
  assert(Option.isSome(descriptor));
  return Layer.unwrap(
    Effect.map(runtime, (opened) =>
      Harnesses.layerFrom(HarnessCatalog.make({ descriptors: [descriptor.value] }), [opened]),
    ),
  );
};

/** `provider`'s fixture for `scenario`, with its runtime registered on the recorded traffic. */
export const toolFixture = (
  provider: ToolProvider,
  scenario: ToolScenario | "supervisor",
  mode: "record" | "replay",
) =>
  Effect.gen(function* () {
    if (provider === "pi") {
      const fixture = yield* openPiFixture(scenario, mode);
      return {
        ...fixture,
        harnesses: registered("pi", piRuntime).pipe(Layer.provide(fixture.harness)),
      };
    }
    const fixture = yield* openFixture(provider, scenario, mode);
    assert("harness" in fixture, `${scenario} replays through the runtime layers`);
    return {
      ...fixture,
      harnesses:
        provider === "claude"
          ? registered("claude", claudeRuntime).pipe(Layer.provide(fixture.harness))
          : registered("codex", codexRuntime).pipe(Layer.provide(fixture.harness)),
    };
  });

/**
 * Opens a role session that serves the contract toolkit on `provider`'s recorded traffic, through
 * the registry, so admission checks the descriptor. Returns the session's answer and events, and
 * the transcript entries.
 */
export const runToolScenario = (
  provider: ToolProvider,
  scenario: ToolScenario,
  mode: "record" | "replay",
) =>
  Effect.gen(function* () {
    const fixture = yield* toolFixture(provider, scenario, mode);
    const { host, worker, machine, cwd, environment } = fixture.request;
    const role = probe(scenario === "closed-tools" ? "none" : "all");
    const session = RoleSession.make({
      // The recorded traffic names the session in process and pid file paths.
      id: AgentSessionId.make("replay-parent:child:1"),
      role: role.name,
      agent: fixture.request.session.agent,
      brain: fixture.request.session.brain,
    });
    const admitted = admitBrain(
      catalog,
      role,
      session.brain,
      AdmissionContext.make({
        placement: "local",
        credential: provider === "pi" ? "host-login" : "gateway-subscription",
      }),
    );
    assert(Result.isSuccess(admitted), `${provider} admits a role with a usine tool set`);
    const spec = SessionSpec.make({
      session,
      admitted: admitted.success,
      host,
      worker,
      machine,
      cwd,
      environment,
    });
    const prompt = prompts[scenario];
    const { message, events } = yield* Effect.gen(function* () {
      const runtime = yield* (yield* Harnesses).runtime(Harness.make(provider));
      const policy = yield* continuationPolicy(spec, prompt, RestartState.make({}));
      const native = yield* runtime.open(
        spec,
        StartPrompt.make({ text: prompt }),
        policy,
        contractTools,
      );
      const collected = yield* Effect.forkScoped(Stream.runCollect(native.running.events));
      const result = yield* native.running.result;
      return { message: result.message, events: yield* Fiber.join(collected) };
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(contractToolHandlers, fixture.harnesses)),
      fixture.tape.guard,
    );
    yield* fixture.save;
    const tape = fixture.tape;
    return {
      message,
      events: [...events] satisfies ReadonlyArray<AgentSessionEvent>,
      entries: tape.source === "record" ? tape.entries : tape.source.entries,
    };
  });
