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
import { Harness, BrainSpec, type ModelId } from "@usine/core/agent/brain";
import {
  EndpointName,
  SessionStarted,
  SessionTokensUpdated,
  TokenCount,
  type UsdAmount,
} from "@usine/core/agent/session";
import { Clock, Deferred, Effect, FiberSet, Layer, Match, Option, Stream } from "effect";
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
  PI_OUTPUT_TOOL,
  piBuiltInToolNames,
  type PiRejection,
  PiSdk,
  type PiSessionStorage,
  type PiStartResult,
  usePiStart,
} from "./sdk.ts";
import type { PiPool } from "./authentication.ts";
import { failedPiTurn } from "./refusal.ts";
import { piMessageUsage } from "../usage.ts";
import { CompletionReply, type CompletionRequest, structuredCompletion } from "../completion.ts";
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

/** Fails with the launch error of a model or credential that rules out `spec`'s brain. */
const rejected = Effect.fn("Pi.rejected")(function* (spec: SessionSpec, rejection: PiRejection) {
  if (rejection._tag === "UnknownModel") {
    yield* Effect.logError("Pi rejected an unknown model", { model: spec.session.brain.model });
    return yield* UnknownModelError.make({
      harness: Harness.make("pi"),
      model: spec.session.brain.model,
      message: `Pi has no model "${spec.session.brain.model}"`,
    });
  }
  if (rejection._tag === "UnsupportedEffort") return yield* unsupportedEffort(rejection);
  const required = requiredPiPool(splitPiModel(rejection.model)?.provider ?? "");
  yield* Effect.logError(
    rejection._tag === "AuthenticationUnavailable"
      ? "Pi has no credential for its model"
      : "Pi model has unsupported OAuth authentication",
    { model: rejection.model, requiredPool: required },
  );
  return yield* PoolUnavailableError.make({
    harness: Harness.make("pi"),
    model: rejection.model,
    pool: required,
    message: `Pi model "${rejection.model}" requires a credential from the ${required} pool`,
  });
});

/** The billing pool, and for an API key the provider, that a Pi session or completion records. */
const resolvedPi = (spec: SessionSpec, model: ModelId, pool: PiPool) =>
  resolvedSession(spec.session, {
    brain: BrainSpec.make({
      harness: Harness.make("pi"),
      model,
      effort: spec.session.brain.effort,
    }),
    pool: Option.some(pool),
    endpoint:
      pool === "apiKeys"
        ? Option.map(Option.fromUndefinedOr(splitPiModel(model)), ({ provider }) =>
            EndpointName.make(provider),
          )
        : Option.none(),
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
            if (started._tag !== "Started") return yield* rejected(spec, started);
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
            const session = resolvedPi(spec, started.model, started.pool);
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
  const completeJson = Effect.fn("PiRuntime.complete")(function* ({
    spec,
    prompt,
    schema,
    spent,
  }: CompletionRequest) {
    yield* Effect.annotateCurrentSpan({
      agent: spec.session.agent,
      effort: spec.session.brain.effort,
      harness: spec.session.brain.harness,
      model: spec.session.brain.model,
      ...parentFields(spec.session),
      sessionId: spec.session.id,
    });
    yield* Effect.logInfo("Starting Pi structured completion");
    const sentAt = yield* Clock.currentTimeMillis;
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        sdk.complete({
          model: spec.session.brain.model,
          thinkingLevel: spec.session.brain.effort,
          prompt,
          schema,
          sentAt,
          signal,
        }),
      catch: (cause) => childError("stream", spec, "Pi structured completion failed", cause),
    });
    if (result._tag !== "Completed") return yield* rejected(spec, result);
    const session = resolvedPi(spec, result.model, result.pool);
    const message = result.message;
    yield* spent(
      SessionTokensUpdated.make({
        session,
        ...Option.getOrElse(piMessageUsage(message), () => ({
          totalTokens: TokenCount.make(0),
          costUsd: Option.none<UsdAmount>(),
        })),
      }),
    );
    // Pi ends a request that the provider stopped as a refusal with an error.
    if (message.stopReason === "error" && message.rawStopReason === "refusal")
      return CompletionReply.Declined({
        message: message.errorMessage || "Pi's model declined to answer",
      });
    if (message.stopReason === "error" || message.stopReason === "aborted")
      return yield* yield* failedPiTurn(session.id, {
        errorMessage: message.errorMessage || `Pi's model request ended with ${message.stopReason}`,
        timestamp: message.timestamp,
      });
    const call = message.content.find(
      (content) => content.type === "toolCall" && content.name === PI_OUTPUT_TOOL,
    );
    if (call === undefined || call.type !== "toolCall")
      return CompletionReply.Missing({
        message: `Pi's model answered without calling ${PI_OUTPUT_TOOL}`,
      });
    if (call.argumentsError !== undefined)
      return CompletionReply.Missing({
        message: `Pi's model sent ${PI_OUTPUT_TOOL} arguments that aren't a JSON object`,
      });
    return CompletionReply.Value({ value: call.arguments });
  });
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
    complete: structuredCompletion(completeJson),
  } satisfies Pick<HarnessRuntime, "open" | "stop" | "complete">;
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
