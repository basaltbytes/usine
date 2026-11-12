import {
  childContinuation,
  checkContinuationHome,
  type ContinuationPolicy,
} from "../continuation.ts";
import { type SessionSpec, type Start } from "../contract.ts";
import { parentFields, resolvedSession, startPrompt, startReference } from "../adapter.ts";
import { HarnessCatalog } from "../harness.ts";
import { piPreflight } from "./preflight.ts";
import { pi } from "./descriptor.ts";
import { type HarnessRuntime, openWithTools } from "../runtime.ts";
import { callHostTool, decodeHostToolInput, type HostToolSet, hostToolNames } from "../tools.ts";
import { Harness, BrainSpec } from "@usine/core/agent/brain";
import { EndpointName, SessionStarted } from "@usine/core/agent/session";
import { Deferred, Effect, FiberSet, Layer, Match, Option, Stream } from "effect";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ChildBackend,
  ChildSessionJournal,
  PoolUnavailableError,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
} from "../../runtime.ts";
import { sessionChannel, subscribePiSession } from "../session.ts";
import {
  piBuiltInToolNames,
  PiSdk,
  type PiSessionStorage,
  type PiStartResult,
  usePiStart,
} from "./sdk.ts";
import { piPauseGate, piTurns } from "./turns.ts";
import { requiredPiPool, splitPiModel } from "./authentication.ts";

export {
  PiSdk,
  piSdkLive,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
  type PiStartResult,
  type PiSessionStorage,
} from "./sdk.ts";

const childError = (
  operation: SessionOperationError["operation"],
  spec: SessionSpec,
  message: string,
  cause: unknown,
) =>
  SessionOperationError.make({
    operation,
    sessionId: Option.some(spec.session.id),
    message,
    cause,
  });

const unsupportedEffort = Effect.fn("Pi.unsupportedEffort")(function* (
  started: Extract<PiStartResult, { readonly _tag: "UnsupportedEffort" }>,
) {
  yield* Effect.logError("Pi child rejected an unsupported effort", {
    effort: started.effort,
    model: started.model,
    supported: started.supported,
  });
  return yield* UnsupportedEffortError.make({
    harness: Harness.make("pi"),
    model: started.model,
    effort: started.effort,
    message: `Pi model "${started.model}" doesn't support effort ${started.effort}. Supported efforts: ${started.supported.join(", ")}`,
  });
});

const piCatalog = HarnessCatalog.make({ descriptors: [pi] });

/** Model APIs take tool names of at most 64 characters; Pi's own tools keep their names. */
const toolNameRule = { maxLength: 64, reserved: piBuiltInToolNames };

/**
 * Defines `tools` as Pi tools, whose calls run in the calling scope. Returns them with the
 * mapping from the name that Pi reports to the toolkit name.
 */
const serveTools = Effect.fn("PiRuntime.serveTools")(function* (tools: HostToolSet) {
  const names = yield* hostToolNames(tools, toolNameRule);
  const call = callHostTool(tools, names);
  const run = yield* FiberSet.makeRuntimePromise();
  const definitions = tools.tools.map((tool): ToolDefinition =>
    defineTool({
      name: names.alias(tool.name),
      label: tool.name,
      description: tool.description,
      // Lists the tool in the system prompt's tool section, as Pi lists its own.
      promptSnippet: tool.description,
      parameters: tool.parameters,
      execute: (toolCallId, params, signal) =>
        run(call(names.alias(tool.name), decodeHostToolInput(params), Option.some(toolCallId)), {
          signal,
        }).then((result) => ({
          content: [{ type: "text", text: result.text }],
          details: undefined,
          isError: result.isError,
        })),
    }),
  );
  return {
    definitions,
    toolName: (reported: string) => Option.getOrElse(names.name(reported), () => reported),
  };
});

const makePiSessions = Effect.gen(function* () {
  const sdk = yield* PiSdk;

  const startSession = Effect.fn("PiRuntime.start")(
    function* (
      spec: SessionSpec,
      storage: PiSessionStorage,
      prompt: Option.Option<string>,
      policy: ContinuationPolicy,
      hostTools: HostToolSet,
    ) {
      yield* Effect.annotateCurrentSpan({
        agent: spec.session.agent,
        effort: spec.session.brain.effort,
        harness: spec.session.brain.harness,
        model: spec.session.brain.model,
        ...parentFields(spec.session),
        sessionId: spec.session.id,
      });
      yield* Effect.logInfo(
        "Starting Pi child session",
        Match.valueTags(storage, {
          InMemory: () => ({ storage: "InMemory" }),
          Create: ({ directory }) => ({ storage: "Create", directory }),
          Resume: ({ directory, id }) => ({ storage: "Resume", directory, harnessSessionId: id }),
        }),
      );
      const gate = yield* piPauseGate;
      const served = yield* serveTools(hostTools);
      return yield* usePiStart(
        (signal) =>
          sdk.start({
            cwd: spec.cwd,
            storage,
            environment: Option.some(spec.environment),
            extensions: [gate.extension],
            nativeTools: spec.admitted.role.nativeTools,
            hostTools: served.definitions,
            model: spec.session.brain.model,
            signal,
            thinkingLevel: spec.session.brain.effort,
          }),
        (cause) => childError("launch", spec, "Pi child session failed to start", cause),
        (acquired) =>
          Effect.gen(function* () {
            const started = acquired.result;
            if (started._tag === "UnknownModel") {
              yield* Effect.logError("Pi child rejected an unknown model", {
                model: spec.session.brain.model,
              });
              return yield* UnknownModelError.make({
                harness: Harness.make("pi"),
                model: spec.session.brain.model,
                message: `Pi has no model "${spec.session.brain.model}"`,
              });
            }
            if (started._tag === "UnsupportedEffort") {
              return yield* unsupportedEffort(started);
            }
            if (
              started._tag === "AuthenticationUnavailable" ||
              started._tag === "UnsupportedAuthentication"
            ) {
              const required = requiredPiPool(splitPiModel(started.model)?.provider ?? "");
              yield* Effect.logError(
                started._tag === "AuthenticationUnavailable"
                  ? "Pi child has no credential for its model"
                  : "Pi child model has unsupported OAuth authentication",
                { model: started.model, requiredPool: required },
              );
              return yield* PoolUnavailableError.make({
                harness: Harness.make("pi"),
                model: started.model,
                pool: required,
                message: `Pi child model "${started.model}" requires a credential from the ${required} pool`,
              });
            }
            yield* Effect.logInfo("Pi child session started", {
              model: started.model,
              pool: started.pool,
              tools: started.tools,
              ...Option.match(started.harnessSession, {
                onNone: () => ({}),
                onSome: (saved) => ({
                  harnessSessionId: saved.id,
                  cwd: saved.cwd,
                  home: saved.home,
                }),
              }),
            });
            const session = resolvedSession(spec.session, {
              brain: BrainSpec.make({
                harness: Harness.make("pi"),
                model: started.model,
                effort: spec.session.brain.effort,
              }),
              pool: Option.some(started.pool),
              endpoint:
                started.pool === "apiKeys"
                  ? Option.map(
                      Option.fromUndefinedOr(splitPiModel(started.model)),
                      ({ provider }) => EndpointName.make(provider),
                    )
                  : Option.none(),
            });
            const channel = yield* sessionChannel({
              label: "Pi child session",
              sessionId: session.id,
            });
            const journal = yield* ChildSessionJournal.current;
            if (Option.isSome(started.harnessSession))
              yield* journal.started(started.harnessSession.value);
            yield* channel.emit(
              SessionStarted.make({ session, harnessSession: started.harnessSession }),
            );
            const subscription = yield* subscribePiSession(
              started.session,
              session,
              channel,
              policy.restored.usage,
              served.toolName,
            );
            yield* Effect.addFinalizer(() =>
              Effect.sync(subscription.unsubscribe).pipe(
                Effect.andThen(Effect.sync(acquired.dispose)),
              ),
            );
            const controls = yield* piTurns({
              session,
              held: policy.restored.held,
              paused: policy.restored.paused,
              idle: policy.restored.idle,
              idleAnsweredOperator: policy.restored.idleAnsweredOperator,
              unread: policy.restored.unread,
              sdk: started.session,
              channel,
              gate,
              prompt,
              policy,
              lastText: subscription.lastText,
              error: (operation, cause) =>
                childError(operation, spec, `Pi child ${operation} failed`, cause),
            });
            const running = {
              session,
              events: Stream.fromQueue(channel.events),
              ...controls,
              result: Deferred.await(channel.result),
            } satisfies RunningSession;
            return { running, active: false, recover: controls.recover };
          }),
      );
    },
    (effect, spec, storage) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logError("Pi child session failed to start", {
            sessionId: spec.session.id,
            storage: storage._tag,
            errorTag: error._tag,
            message: error.message,
          }),
        ),
      ),
  );
  const directory = (spec: SessionSpec) => `${spec.cwd}/.usine/pi/sessions`;
  const open = Effect.fn("PiRuntime.open")(function* (
    spec: SessionSpec,
    start: Start,
    policy: ContinuationPolicy,
    hostTools: HostToolSet,
  ) {
    yield* checkContinuationHome(
      spec,
      start,
      Option.some(directory(spec)),
      Option.some(directory(spec)),
    );
    return yield* startSession(
      spec,
      Option.match(startReference(start), {
        onNone: () => ({ _tag: "Create" as const, directory: directory(spec) }),
        onSome: (saved) => ({
          _tag: "Resume" as const,
          directory: directory(spec),
          id: saved.id,
        }),
      }),
      startPrompt(start),
      policy,
      hostTools,
    );
  });
  return {
    open: openWithTools(open),
    stop: (_spec: SessionSpec) => Effect.void,
  } satisfies Pick<HarnessRuntime, "open" | "stop">;
});

/** Provides `ChildBackend` for local child sessions using API keys or a ChatGPT subscription. Requires `PiSdk`; remote hosts fail with `AgentResultError`. */
export const piChildLayer = Layer.effect(
  ChildBackend,
  Effect.map(makePiSessions, (sessions) => childContinuation(piCatalog, sessions)),
);

/** Combines preflight and scoped sessions, new or reopened from a saved conversation. */
export const piRuntime = Effect.gen(function* () {
  const sessions = yield* makePiSessions;
  const preflight = yield* piPreflight;
  return { id: pi.id, preflight, ...sessions } satisfies HarnessRuntime;
});
