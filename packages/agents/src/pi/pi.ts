import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@usine/core";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import { assemblePrompt } from "../prompt.ts";
import {
  type AgentSessionError,
  AgentRuntime,
  ChildBackend,
  type ChildRequest,
  type LaunchRequest,
  PiChildBackend,
  PoolUnavailableError,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
} from "../runtime.ts";
import {
  type PiAuthentication,
  type PiPool,
  requiredPiPool,
  resolvePiPool,
} from "./authentication.ts";
import { type SessionChannel, sessionChannel } from "./session.ts";
import { subagentsExtension } from "./subagents.ts";

export type PiSessionEvent = AgentSessionEvent;
type PiMessage = Awaited<ReturnType<typeof createAgentSession>>["session"]["messages"][number];

/** Narrow in-process Pi session surface consumed by the adapter. */
export interface PiSession {
  readonly messages: ReadonlyArray<PiMessage>;
  readonly subscribe: (listener: (event: PiSessionEvent) => void) => () => void;
  readonly prompt: (prompt: string) => Promise<void>;
  readonly steer: (message: string) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
}

export interface PiStartOptions {
  readonly cwd: string;
  readonly extensions: ReadonlyArray<InlineExtension>;
  readonly model: Option.Option<Agent.ModelId>;
  readonly signal: AbortSignal;
  readonly thinkingLevel: Agent.Effort;
}

export type PiStartResult =
  | {
      readonly _tag: "AuthenticationUnavailable";
      readonly model: Agent.ModelId;
      readonly requiredPool: PiPool;
    }
  | {
      readonly _tag: "UnsupportedAuthentication";
      readonly authentication: Extract<PiAuthentication, { readonly _tag: "OAuth" }>;
      readonly model: Agent.ModelId;
      readonly requiredPool: PiPool;
    }
  | { readonly _tag: "UnknownModel" }
  | {
      readonly _tag: "Started";
      readonly model: Agent.ModelId;
      readonly pool: PiPool;
      readonly session: PiSession;
    };

/** Narrow SDK seam keeps vendor setup testable without module replacement. */
export class PiSdk extends Context.Service<
  PiSdk,
  { readonly start: (options: PiStartOptions) => Promise<PiStartResult> }
>()("@usine/agents/pi/PiSdk") {}

const splitModel = (model: Agent.ModelId): readonly [string, string] | undefined => {
  const separator = model.indexOf("/");
  return separator <= 0 || separator === model.length - 1
    ? undefined
    : [model.slice(0, separator), model.slice(separator + 1)];
};

export const piSdkLive = Layer.succeed(PiSdk)({
  start: async (options) => {
    const modelRuntime = await ModelRuntime.create({ signal: options.signal });
    let selected: ReturnType<ModelRuntime["getModel"]>;
    if (Option.isSome(options.model)) {
      const parts = splitModel(options.model.value);
      if (parts === undefined) return { _tag: "UnknownModel" };
      selected = modelRuntime.getModel(parts[0], parts[1]);
      if (selected === undefined) return { _tag: "UnknownModel" };
    }
    const agentDir = getAgentDir();
    // The Attempt worktree is repository-controlled input: never trust its
    // `.pi/` settings, SYSTEM.md, extensions, or skills. The subagents tool
    // arrives as an inline factory, which the loader registers regardless.
    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      agentDir,
      cwd: options.cwd,
      extensionFactories: [...options.extensions],
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    const sessionOptions = {
      cwd: options.cwd,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager,
      thinkingLevel: options.thinkingLevel,
    } as const;
    const { session } =
      selected === undefined
        ? await createAgentSession(sessionOptions)
        : await createAgentSession({ ...sessionOptions, model: selected });
    let ownershipTransferred = false;
    try {
      const active = session.model;
      if (active === undefined) throw new Error("Pi started without an active model");
      const model = Agent.ModelId.make(`${active.provider}/${active.id}`);
      const resolvedAuthentication = await modelRuntime.checkAuth(active.provider, {
        signal: options.signal,
      });
      const authentication: PiAuthentication | undefined =
        resolvedAuthentication?.type === "api_key"
          ? { _tag: "ApiKey" }
          : resolvedAuthentication?.type === "oauth"
            ? {
                _tag: "OAuth",
                subscription:
                  modelRuntime.getProvider(active.provider)?.auth.oauth?.isSubscription === true,
              }
            : undefined;
      const requiredPool = requiredPiPool(active.provider);
      const pool = resolvePiPool(active.provider, authentication);
      if (authentication === undefined) {
        return { _tag: "AuthenticationUnavailable", model, requiredPool };
      }
      if (pool === undefined && authentication._tag === "OAuth") {
        return {
          _tag: "UnsupportedAuthentication",
          authentication,
          model,
          requiredPool,
        };
      }
      if (pool === undefined) {
        throw new Error("Pi could not map a configured API key to a billing pool");
      }
      ownershipTransferred = true;
      return {
        _tag: "Started",
        model,
        pool,
        session,
      };
    } finally {
      if (!ownershipTransferred) session.dispose();
    }
  },
});

const PiAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});
const PiTextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const decodeSerializedJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
type PiToolStartedEvent = Extract<PiSessionEvent, { readonly type: "tool_execution_start" }>;
type PiToolFinishedEvent = Extract<PiSessionEvent, { readonly type: "tool_execution_end" }>;

const toolInputJson = (event: PiToolStartedEvent): Schema.Json => {
  try {
    return decodeSerializedJson(JSON.stringify(event.args) ?? "null");
  } catch {
    return String(event.args);
  }
};

const toolOutputJson = (event: PiToolFinishedEvent): Schema.Json => {
  try {
    return decodeSerializedJson(JSON.stringify(event.result) ?? "null");
  } catch {
    return String(event.result);
  }
};

const messageText = (message: PiMessage): string | undefined => {
  if (!Schema.is(PiAssistantMessage)(message)) return undefined;
  if (Schema.is(Schema.String)(message.content)) return message.content.trim() || undefined;
  const text = message.content
    .filter(Schema.is(PiTextBlock))
    .map(({ text }) => text)
    .join("")
    .trim();
  return text || undefined;
};

const lastMessageText = (messages: ReadonlyArray<PiMessage>): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const text = messageText(message);
    if (text !== undefined) return text;
  }
  return undefined;
};

const sessionEventFrom = (
  event: PiSessionEvent,
  session: Agent.Session,
): Agent.SessionEvent | undefined => {
  if (event.type === "message_end") {
    const text = messageText(event.message);
    return text === undefined ? undefined : new Agent.TextOutput({ session, text });
  }
  if (event.type === "tool_execution_start") {
    return new Agent.ToolStarted({
      session,
      callId: event.toolCallId,
      tool: event.toolName,
      input: toolInputJson(event),
    });
  }
  if (event.type === "tool_execution_end") {
    return new Agent.ToolFinished({
      session,
      callId: event.toolCallId,
      tool: event.toolName,
      output: toolOutputJson(event),
      isError: event.isError,
    });
  }
  return undefined;
};

const parentError = (
  operation: SessionOperationError["operation"],
  request: LaunchRequest,
  message: string,
  cause: unknown,
) =>
  new SessionOperationError({
    operation,
    sessionId: Option.some(Agent.SessionId.make(`parent:${request.spec.attemptId}`)),
    message,
    cause,
  });

const childError = (
  operation: SessionOperationError["operation"],
  request: ChildRequest,
  message: string,
  cause: unknown,
) =>
  new SessionOperationError({
    operation,
    sessionId: Option.some(request.session.id),
    message,
    cause,
  });

interface AcquiredPiStart {
  readonly result: PiStartResult;
  /** Idempotent because both failed setup and the ambient scope may request cleanup. */
  readonly dispose: () => void;
}

/**
 * Keeps SDK startup interruptible while retaining ownership until setup succeeds.
 * A result that loses the race with interruption is disposed in its Promise
 * continuation; a result already handed to `use` is disposed by `onExit`.
 */
const usePiStart = <A, E, R, E2>(
  start: (signal: AbortSignal) => Promise<PiStartResult>,
  onError: (cause: unknown) => E,
  use: (acquired: AcquiredPiStart) => Effect.Effect<A, E2, R>,
): Effect.Effect<A, E | E2, R> =>
  Effect.suspend(() => {
    let acquired: AcquiredPiStart | undefined;
    let abandoned = false;
    let pending = true;
    const acquire = Effect.tryPromise({
      try: (signal) =>
        start(signal).then(
          (result) => {
            pending = false;
            let disposed = false;
            acquired = {
              result,
              dispose: () => {
                if (disposed) return;
                disposed = true;
                if (result._tag === "Started") result.session.dispose();
              },
            };
            if (abandoned || signal.aborted) acquired.dispose();
            return acquired;
          },
          (cause) => {
            pending = false;
            throw cause;
          },
        ),
      catch: onError,
    });
    return acquire.pipe(
      Effect.flatMap(use),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void;
        abandoned = true;
        if (acquired?.result._tag === "Started") {
          return Effect.logWarning("Disposing Pi session after an incomplete launch", {
            model: acquired.result.model,
            pool: acquired.result.pool,
          }).pipe(Effect.andThen(Effect.sync(acquired.dispose)));
        }
        return pending
          ? Effect.logWarning(
              "Pi launch ended during SDK startup; any late-created session will be disposed",
            )
          : Effect.void;
      }),
    );
  });

/**
 * Bridges the Pi SDK's synchronous subscriber onto one session channel.
 * Normalized events reach the queue on the SDK's own tick — no async hop, so
 * nothing can trail the prompt's resolution — while operational events with
 * no normalized shape (retry backoffs, compactions) are logged through the
 * launch fiber's captured services so a silent wait stays explainable.
 */
const subscribeSession = (piSession: PiSession, session: Agent.Session, channel: SessionChannel) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const log = Effect.runForkWith(context);
    let lastText: string | undefined;
    const unsubscribe = piSession.subscribe((event) => {
      if (event.type === "auto_retry_start") {
        log(
          Effect.logWarning("Pi session is backing off before a retry", {
            attempt: event.attempt,
            delayMillis: event.delayMs,
            errorMessage: event.errorMessage,
            maxAttempts: event.maxAttempts,
            sessionId: session.id,
          }),
        );
        return;
      }
      if (event.type === "auto_retry_end") {
        log(
          Effect.logInfo("Pi session finished retrying", {
            attempt: event.attempt,
            finalError: event.finalError,
            sessionId: session.id,
            success: event.success,
          }),
        );
        return;
      }
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        log(
          Effect.logInfo("Pi session context compaction", {
            phase: event.type,
            reason: event.reason,
            sessionId: session.id,
          }),
        );
        return;
      }
      const sessionEvent = sessionEventFrom(event, session);
      if (sessionEvent === undefined) return;
      if (sessionEvent._tag === "TextOutput") lastText = sessionEvent.text;
      if (!Queue.offerUnsafe(channel.events, sessionEvent)) {
        log(
          Effect.logWarning("Dropped a Pi session event after the terminal transition", {
            event: sessionEvent._tag,
            sessionId: session.id,
          }),
        );
      }
    });
    channel.onTerminal(unsubscribe);
    return { lastText: () => lastText, unsubscribe };
  });

const makePiChild = Effect.gen(function* () {
  const sdk = yield* PiSdk;

  const launch: PiChildBackend["Service"]["launch"] = Effect.fn("PiChildBackend.launch")(
    function* (request) {
      yield* Effect.annotateCurrentSpan({
        agent: request.session.agent,
        effort: request.session.brain.effort,
        harness: request.session.brain.harness,
        model: request.session.brain.model,
        parentSessionId: request.session.parentId,
        sessionId: request.session.id,
      });
      yield* Effect.logInfo("Launching Pi child session");
      return yield* usePiStart(
        (signal) =>
          sdk.start({
            cwd: request.cwd,
            extensions: [],
            model: Option.some(request.session.brain.model),
            signal,
            thinkingLevel: request.session.brain.effort,
          }),
        (cause) => childError("launch", request, "Pi child session failed to start", cause),
        (acquired) =>
          Effect.gen(function* () {
            const started = acquired.result;
            if (started._tag === "UnknownModel") {
              yield* Effect.logError("Pi child rejected an unknown model", {
                model: request.session.brain.model,
              });
              return yield* new UnknownModelError({
                harness: "pi",
                model: request.session.brain.model,
                message: `Pi does not expose model ${request.session.brain.model}`,
              });
            }
            if (started._tag === "AuthenticationUnavailable") {
              yield* Effect.logError("Pi child has no credential for its model", {
                model: started.model,
                requiredPool: "apiKeys",
              });
              return yield* new PoolUnavailableError({
                harness: "pi",
                model: started.model,
                pool: "apiKeys",
                message: `Pi child model ${started.model} must use an API key`,
              });
            }
            if (started._tag === "UnsupportedAuthentication") {
              yield* Effect.logError("Pi child model has unsupported OAuth authentication", {
                model: started.model,
                requiredPool: "apiKeys",
                subscription: started.authentication.subscription,
              });
              return yield* new PoolUnavailableError({
                harness: "pi",
                model: started.model,
                pool: "apiKeys",
                message: `Pi child model ${started.model} must use an API key`,
              });
            }
            if (started.pool !== "apiKeys") {
              yield* Effect.logError("Pi child resolved to an unsupported billing pool", {
                model: started.model,
                requiredPool: "apiKeys",
                resolvedPool: started.pool,
              });
              return yield* new PoolUnavailableError({
                harness: "pi",
                model: started.model,
                pool: "apiKeys",
                message: `Pi child model ${started.model} must use an API key`,
              });
            }
            const session = new Agent.ChildSession({
              id: request.session.id,
              parentId: request.session.parentId,
              agent: request.session.agent,
              brain: new Agent.BrainSpec({
                harness: "pi",
                model: started.model,
                effort: request.session.brain.effort,
              }),
            });
            const channel = yield* sessionChannel({
              label: "Pi child session",
              sessionId: session.id,
            });
            yield* channel.emit(new Agent.SessionStarted({ session }));
            const subscription = yield* subscribeSession(started.session, session, channel);
            // Once setup succeeds, the ambient scope owns both subscription and SDK session.
            yield* Effect.addFinalizer(() =>
              Effect.sync(subscription.unsubscribe).pipe(
                Effect.andThen(Effect.sync(acquired.dispose)),
              ),
            );
            yield* Effect.tryPromise({
              try: () => started.session.prompt(request.prompt),
              catch: (cause) => childError("stream", request, "Pi child session failed", cause),
            }).pipe(
              Effect.flatMap(() =>
                channel.finish(
                  session,
                  subscription.lastText() ??
                    lastMessageText(started.session.messages) ??
                    "Pi child session completed",
                ),
              ),
              Effect.catch((error) => channel.fail(error)),
              Effect.forkScoped,
            );

            const steer = Effect.fn("PiChildBackend.steer")((message: string) =>
              Effect.logDebug("Steering Pi child session", {
                sessionId: session.id,
              }).pipe(
                Effect.andThen(
                  Effect.tryPromise({
                    try: () => started.session.steer(message),
                    catch: (cause) =>
                      childError("steer", request, "Could not steer Pi child", cause),
                  }),
                ),
              ),
            );
            const interrupt = Effect.logInfo("Interrupting Pi child session", {
              sessionId: session.id,
            }).pipe(
              Effect.andThen(
                Effect.tryPromise({
                  try: () => started.session.abort(),
                  catch: (cause) =>
                    childError("interrupt", request, "Could not interrupt Pi child", cause),
                }),
              ),
            );
            return {
              session,
              events: Stream.fromQueue(channel.events),
              interrupt,
              result: Deferred.await(channel.result),
              steer,
            } satisfies RunningSession;
          }),
      );
    },
  );
  return PiChildBackend.of({ launch });
});

const makePiParent = Effect.gen(function* () {
  const children = yield* ChildBackend;
  const sdk = yield* PiSdk;

  const launch: AgentRuntime["Service"]["launch"] = Effect.fn("PiParentRuntime.launch")(
    function* (request) {
      const parentId = Agent.SessionId.make(`parent:${request.spec.attemptId}`);
      yield* Effect.annotateCurrentSpan({
        agent: request.spec.agent.name,
        attemptId: request.spec.attemptId,
        effort: request.spec.agent.brain.effort,
        parentModel: Option.getOrUndefined(request.spec.parentModel),
        repository: request.spec.repository,
        sessionId: parentId,
      });
      yield* Effect.logInfo("Launching Pi parent session");
      const channel = yield* sessionChannel({
        label: "Pi parent session",
        sessionId: parentId,
      });
      // The Pi tool callback runs outside any usine fiber. Child programs must
      // still carry this fiber's services (stderr logging, tracing) and die
      // with this launch scope, so the extension receives a runner instead of
      // reaching for the default runtime.
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<never>();
      const runChild = <A>(program: Effect.Effect<A, AgentSessionError>): Promise<A> =>
        Effect.runPromise(
          program.pipe(
            Effect.provideContext(context),
            Effect.forkIn(scope),
            Effect.flatMap(Fiber.join),
          ),
        );
      return yield* usePiStart(
        (signal) =>
          sdk.start({
            cwd: request.cwd,
            extensions: [
              subagentsExtension({
                agent: request.spec.agent,
                backend: children,
                cwd: request.cwd,
                emit: channel.emit,
                parentId,
                run: runChild,
              }),
            ],
            model: request.spec.parentModel,
            signal,
            thinkingLevel: request.spec.agent.brain.effort,
          }),
        (cause) => parentError("launch", request, "Pi parent session failed to start", cause),
        (acquired) =>
          Effect.gen(function* () {
            const started = acquired.result;
            if (started._tag === "UnknownModel") {
              const model = Option.getOrElse(request.spec.parentModel, () =>
                Agent.ModelId.make("unknown"),
              );
              yield* Effect.logError("Pi parent rejected an unknown model", { model });
              return yield* new UnknownModelError({
                harness: "pi",
                model,
                message: `Pi does not expose model ${model}`,
              });
            }
            if (started._tag === "AuthenticationUnavailable") {
              yield* Effect.logError("Pi parent has no credential for its model", {
                model: started.model,
                requiredPool: started.requiredPool,
              });
              return yield* new PoolUnavailableError({
                harness: "pi",
                model: started.model,
                pool: started.requiredPool,
                message: `Pi parent model ${started.model} requires a credential from the ${started.requiredPool} pool`,
              });
            }
            if (started._tag === "UnsupportedAuthentication") {
              yield* Effect.logError("Pi parent model has unsupported OAuth authentication", {
                model: started.model,
                requiredPool: started.requiredPool,
                subscription: started.authentication.subscription,
              });
              return yield* new PoolUnavailableError({
                harness: "pi",
                model: started.model,
                pool: started.requiredPool,
                message: `Pi parent model ${started.model} requires a credential from the ${started.requiredPool} pool`,
              });
            }
            yield* Effect.annotateCurrentSpan({ parentPool: started.pool });
            yield* Effect.logInfo("Pi parent session authenticated", {
              model: started.model,
              pool: started.pool,
            });
            const parent = new Agent.ParentSession({
              id: parentId,
              agent: request.spec.agent.name,
              brain: new Agent.BrainSpec({
                harness: "pi",
                model: started.model,
                effort: request.spec.agent.brain.effort,
              }),
            });
            yield* channel.emit(new Agent.SessionStarted({ session: parent }));
            const subscription = yield* subscribeSession(started.session, parent, channel);
            // Once setup succeeds, the ambient scope owns both subscription and SDK session.
            yield* Effect.addFinalizer(() =>
              Effect.sync(subscription.unsubscribe).pipe(
                Effect.andThen(Effect.sync(acquired.dispose)),
              ),
            );

            const prompt = assemblePrompt({
              repository: request.spec.repository,
              payload: request.spec.payload,
              agent: request.spec.agent.name,
              persona: request.spec.agent.persona,
              task: request.spec.task,
            });
            const run = Effect.tryPromise({
              try: () => started.session.prompt(prompt),
              catch: (cause) => parentError("stream", request, "Pi parent session failed", cause),
            }).pipe(
              Effect.flatMap(() =>
                channel.finish(
                  parent,
                  subscription.lastText() ??
                    lastMessageText(started.session.messages) ??
                    "Pi parent session completed",
                ),
              ),
              Effect.catch((error) => channel.fail(error)),
            );
            yield* Effect.forkScoped(run);

            const steer = Effect.fn("PiParentRuntime.steer")((message: string) =>
              Effect.logDebug("Steering Pi parent session", {
                sessionId: parentId,
              }).pipe(
                Effect.andThen(
                  Effect.tryPromise({
                    try: () => started.session.steer(message),
                    catch: (cause) => parentError("steer", request, "Could not steer Pi", cause),
                  }),
                ),
              ),
            );
            const interrupt = Effect.logInfo("Interrupting Pi parent session", {
              sessionId: parentId,
            }).pipe(
              Effect.andThen(
                Effect.tryPromise({
                  try: () => started.session.abort(),
                  catch: (cause) =>
                    parentError("interrupt", request, "Could not interrupt Pi", cause),
                }),
              ),
            );
            return {
              session: parent,
              events: Stream.fromQueue(channel.events),
              interrupt,
              result: Deferred.await(channel.result),
              steer,
            } satisfies RunningSession;
          }),
      );
    },
  );
  return AgentRuntime.of({ launch });
});

export const piParentLayer = Layer.effect(AgentRuntime, makePiParent);
export const piChildBackendLayer = Layer.effect(PiChildBackend, makePiChild);
