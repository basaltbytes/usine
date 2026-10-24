import { BrainSpec } from "@usine/core/agent/brain";
import { ChildSession, SessionStarted } from "@usine/core/agent/session";
import { Deferred, Effect, Layer, Option, Stream } from "effect";
import {
  AgentResultError,
  type ChildRequest,
  PiChildBackend,
  PoolUnavailableError,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
} from "../runtime.ts";
import { sessionChannel, subscribePiSession } from "./session.ts";
import { PiSdk, type PiStartResult, usePiStart } from "./sdk.ts";
import { piPauseGate, piTurns } from "./turns.ts";

export {
  PiSdk,
  piSdkLive,
  type PiSession,
  type PiSessionEvent,
  type PiStartOptions,
  type PiStartResult,
} from "./sdk.ts";

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
  started: Extract<PiStartResult, { readonly _tag: "UnsupportedEffort" }>,
) {
  yield* Effect.logError("Pi child rejected an unsupported effort", {
    effort: started.effort,
    model: started.model,
    supported: started.supported,
  });
  return yield* new UnsupportedEffortError({
    harness: "pi",
    model: started.model,
    effort: started.effort,
    message: `Pi model "${started.model}" doesn't support effort ${started.effort}. Supported efforts: ${started.supported.join(", ")}`,
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
      if (request.host._tag === "RemoteShell") {
        yield* Effect.logError("Pi child refused a remote host", {
          destination: request.host.destination,
        });
        return yield* new AgentResultError({
          sessionId: Option.some(request.session.id),
          message:
            "Pi children run only on local workers: their tools run in the orchestrator process, not on the worker",
        });
      }
      yield* Effect.logInfo("Launching Pi child session");
      const gate = yield* piPauseGate;
      return yield* usePiStart(
        (signal) =>
          sdk.start({
            cwd: request.cwd,
            environment: Option.some(request.environment),
            extensions: [gate.extension],
            model: request.session.brain.model,
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
                message: `Pi has no model "${request.session.brain.model}"`,
              });
            }
            if (started._tag === "UnsupportedEffort") {
              return yield* unsupportedEffort(started);
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
                message: `Pi child model "${started.model}" must use an API key`,
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
                message: `Pi child model "${started.model}" must use an API key`,
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
                message: `Pi child model "${started.model}" must use an API key`,
              });
            }
            yield* Effect.logDebug("Pi child session started", {
              model: started.model,
              pool: started.pool,
              tools: started.tools,
            });
            const session = new ChildSession({
              id: request.session.id,
              parentId: request.session.parentId,
              agent: request.session.agent,
              brain: new BrainSpec({
                harness: "pi",
                model: started.model,
                effort: request.session.brain.effort,
              }),
              gatewayCredential: request.session.gatewayCredential,
            });
            const channel = yield* sessionChannel({
              label: "Pi child session",
              sessionId: session.id,
            });
            yield* channel.emit(new SessionStarted({ session }));
            const subscription = yield* subscribePiSession(started.session, session, channel);
            yield* Effect.addFinalizer(() =>
              Effect.sync(subscription.unsubscribe).pipe(
                Effect.andThen(Effect.sync(acquired.dispose)),
              ),
            );
            const controls = yield* piTurns({
              session,
              sdk: started.session,
              channel,
              gate,
              prompt: request.prompt,
              lastText: subscription.lastText,
              error: (operation, cause) =>
                childError(operation, request, `Pi child ${operation} failed`, cause),
            });
            return {
              session,
              events: Stream.fromQueue(channel.events),
              ...controls,
              result: Deferred.await(channel.result),
            } satisfies RunningSession;
          }),
      );
    },
  );
  return PiChildBackend.of({ launch });
});

export const piChildBackendLayer = Layer.effect(PiChildBackend, makePiChild);
