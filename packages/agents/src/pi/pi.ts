import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  SessionStarted,
} from "@usine/core/agent/session";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { assemblePrompt } from "../prompt.ts";
import {
  type AgentSessionError,
  AgentRuntime,
  ChildBackend,
  ChildSessionBudgetExceededError,
  type ChildRequest,
  type LaunchRequest,
  PiChildBackend,
  PoolUnavailableError,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
} from "../runtime.ts";
import { lastPiMessageText, sessionChannel, subscribePiSession } from "./session.ts";
import { PiSdk, type PiStartResult, usePiStart } from "./sdk.ts";
import { subagentsExtension } from "./subagents.ts";

export {
  PiSdk,
  piSdkLive,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
  type PiStartResult,
} from "./sdk.ts";

const parentError = (
  operation: SessionOperationError["operation"],
  request: LaunchRequest,
  message: string,
  cause: unknown,
) =>
  new SessionOperationError({
    operation,
    sessionId: Option.some(AgentSessionId.make(`parent:${request.spec.attemptId}`)),
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

const unsupportedEffort = Effect.fn("Pi.unsupportedEffort")(function* (
  role: "child" | "parent",
  started: Extract<PiStartResult, { readonly _tag: "UnsupportedEffort" }>,
) {
  yield* Effect.logError(`Pi ${role} rejected an unsupported effort`, {
    effort: started.effort,
    model: started.model,
    supported: started.supported,
  });
  return yield* new UnsupportedEffortError({
    harness: "pi",
    model: started.model,
    effort: started.effort,
    message: `Pi model ${started.model} does not support effort ${started.effort}; supported: ${started.supported.join(", ")}`,
  });
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
            toolMode: "repository",
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
            if (started._tag === "UnsupportedEffort") {
              return yield* unsupportedEffort("child", started);
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
            const session = new ChildSession({
              id: request.session.id,
              parentId: request.session.parentId,
              agent: request.session.agent,
              brain: new BrainSpec({
                harness: "pi",
                model: started.model,
                effort: request.session.brain.effort,
              }),
            });
            const channel = yield* sessionChannel({
              label: "Pi child session",
              sessionId: session.id,
            });
            yield* channel.emit(new SessionStarted({ session }));
            const subscription = yield* subscribePiSession(started.session, session, channel);
            // After setup succeeds, the ambient scope closes both the subscription and the SDK session.
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
                    lastPiMessageText(started.session.messages) ??
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
      const parentId = AgentSessionId.make(`parent:${request.spec.attemptId}`);
      yield* Effect.annotateCurrentSpan({
        agent: request.spec.agent.name,
        attemptId: request.spec.attemptId,
        effort: request.spec.agent.brain.effort,
        parentEffort: request.spec.parentEffort,
        parentModel: Option.getOrUndefined(request.spec.parentModel),
        repository: request.spec.repository,
        sessionId: parentId,
      });
      yield* Effect.logInfo("Launching Pi parent session");
      const channel = yield* sessionChannel({
        label: "Pi parent session",
        sessionId: parentId,
      });
      const childBudgetExceeded = yield* Deferred.make<ChildSessionBudgetExceededError>();
      // Pi calls the tool outside any usine fiber. Child programs still need
      // this fiber's services (stderr logging, tracing) and must end with this
      // launch scope, so the extension gets a runner instead of the default
      // runtime.
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
                maxChildren: request.spec.maxChildren,
                onBudgetExceeded: (error) =>
                  Deferred.succeed(childBudgetExceeded, error).pipe(Effect.asVoid),
                parentId,
                run: runChild,
              }),
            ],
            model: request.spec.parentModel,
            signal,
            thinkingLevel: request.spec.parentEffort,
            toolMode: "orchestration",
          }),
        (cause) => parentError("launch", request, "Pi parent session failed to start", cause),
        (acquired) =>
          Effect.gen(function* () {
            const started = acquired.result;
            if (started._tag === "UnknownModel") {
              const model = Option.getOrElse(request.spec.parentModel, () =>
                ModelId.make("unknown"),
              );
              yield* Effect.logError("Pi parent rejected an unknown model", {
                model,
              });
              return yield* new UnknownModelError({
                harness: "pi",
                model,
                message: `Pi does not expose model ${model}`,
              });
            }
            if (started._tag === "UnsupportedEffort") {
              return yield* unsupportedEffort("parent", started);
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
            const parent = new ParentSession({
              id: parentId,
              agent: request.spec.agent.name,
              brain: new BrainSpec({
                harness: "pi",
                model: started.model,
                effort: request.spec.parentEffort,
              }),
            });
            yield* channel.emit(new SessionStarted({ session: parent }));
            const subscription = yield* subscribePiSession(started.session, parent, channel);
            // After setup succeeds, the ambient scope closes both the subscription and the SDK session.
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
            const abort = Effect.tryPromise({
              try: () => started.session.abort(),
              catch: (cause) => parentError("interrupt", request, "Could not interrupt Pi", cause),
            });
            // Fail the channel before aborting the SDK: abort settles the
            // in-flight prompt, and its fiber must find the result already
            // terminal instead of racing it to `channel.finish`.
            const budgetFailure = Deferred.await(childBudgetExceeded).pipe(
              Effect.tap((error) =>
                Effect.logWarning(
                  "Stopping Pi parent after its child session budget was exceeded",
                  {
                    attemptedChildren: error.attemptedChildren,
                    maxChildren: error.maxChildren,
                    sessionId: parentId,
                  },
                ),
              ),
              Effect.flatMap((error) => channel.fail(error)),
              Effect.andThen(
                abort.pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Pi parent kept running after its budget failure", {
                      message: error.message,
                      sessionId: parentId,
                    }),
                  ),
                ),
              ),
            );
            const run = Effect.raceFirst(
              Effect.tryPromise({
                try: () => started.session.prompt(prompt),
                catch: (cause) => parentError("stream", request, "Pi parent session failed", cause),
              }).pipe(
                Effect.flatMap(() =>
                  channel.finish(
                    parent,
                    subscription.lastText() ??
                      lastPiMessageText(started.session.messages) ??
                      "Pi parent session completed",
                  ),
                ),
              ),
              budgetFailure,
            ).pipe(Effect.catch((error) => channel.fail(error)));
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
            }).pipe(Effect.andThen(abort));
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

/** Provides the coordinating Pi parent; supply the child backend that will perform its delegated coding work. */
export const piParentLayer = Layer.effect(AgentRuntime, makePiParent);
/** Provides Pi coding sessions for tasks delegated by a parent. */
export const piChildBackendLayer = Layer.effect(PiChildBackend, makePiChild);
