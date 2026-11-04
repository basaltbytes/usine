import { piPreflight } from "./preflight.ts";
import { pi } from "./descriptor.ts";
import type { HarnessRuntime } from "../runtime.ts";
import { Harness, BrainSpec } from "@usine/core/agent/brain";
import { ChildSession, SessionStarted } from "@usine/core/agent/session";
import { Deferred, Effect, Layer, Option, Stream } from "effect";
import {
  AgentResultError,
  type ChildRequest,
  ChildBackend,
  PoolUnavailableError,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
  UnsupportedEffortError,
} from "../../runtime.ts";
import { sessionChannel, subscribePiSession } from "../session.ts";
import { PiSdk, type PiStartResult, usePiStart } from "./sdk.ts";
import { piPauseGate, piTurns } from "./turns.ts";
import { requiredPiPool, splitPiModel } from "./authentication.ts";

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
  SessionOperationError.make({
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
  return yield* UnsupportedEffortError.make({
    harness: Harness.make("pi"),
    model: started.model,
    effort: started.effort,
    message: `Pi model "${started.model}" doesn't support effort ${started.effort}. Supported efforts: ${started.supported.join(", ")}`,
  });
});

const makePiChild = Effect.gen(function* () {
  const sdk = yield* PiSdk;

  const launch: ChildBackend["Service"]["launch"] = Effect.fn("PiRuntime.launch")(
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
        return yield* AgentResultError.make({
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
              return yield* UnknownModelError.make({
                harness: Harness.make("pi"),
                model: request.session.brain.model,
                message: `Pi has no model "${request.session.brain.model}"`,
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
            });
            const session = ChildSession.make({
              id: request.session.id,
              parentId: request.session.parentId,
              agent: request.session.agent,
              brain: BrainSpec.make({
                harness: Harness.make("pi"),
                model: started.model,
                effort: request.session.brain.effort,
              }),
              gatewayCredential: request.session.gatewayCredential,
            });
            const channel = yield* sessionChannel({
              label: "Pi child session",
              sessionId: session.id,
            });
            yield* channel.emit(SessionStarted.make({ session }));
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
  return ChildBackend.of({ launch });
});

/** Provides `ChildBackend` for local child sessions using API keys or a ChatGPT subscription. Requires `PiSdk`; remote hosts fail with `AgentResultError`. */
export const piChildLayer = Layer.effect(ChildBackend, makePiChild);

/** Combines preflight and scoped launch for registration. */
export const piRuntime = Effect.gen(function* () {
  const child = yield* makePiChild;
  const preflight = yield* piPreflight;
  return { id: pi.id, preflight, launch: child.launch } satisfies HarnessRuntime;
});
