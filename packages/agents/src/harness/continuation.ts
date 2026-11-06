import { Clock, Effect, Option, Result, Scope, Exit } from "effect";
import {
  type AgentSessionEvent,
  type ChildSession,
  type HarnessSession,
  ToolFinished,
} from "@usine/core/agent/session";
import {
  ChildRequest,
  ChildSessionJournal,
  ContinuationLimitError,
  ContinuationMismatchError,
  SessionInterruptedError,
  type AgentSessionError,
  type ChildBackendService,
  type InterruptedTool,
  type QueuedOperatorMessage,
  type RunningSession,
} from "../runtime.ts";
import type { HarnessRuntime, ReopenedSession } from "./runtime.ts";

export const checkContinuation = Effect.fn("HarnessContinuation.check")(function* (
  request: ChildRequest,
  field: ContinuationMismatchError["field"],
  saved: Option.Option<string>,
  current: Option.Option<string>,
) {
  yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, field });
  if (Option.getOrNull(saved) === Option.getOrNull(current)) return;
  const message = `Cannot resume ${request.session.brain.harness}: ${field} mismatch (saved ${Option.getOrElse(saved, () => "default")}, current ${Option.getOrElse(current, () => "default")})`;
  yield* Effect.logWarning("Saved child continuation refused", {
    sessionId: request.session.id,
    field,
    message,
  });
  return yield* ContinuationMismatchError.make({ sessionId: request.session.id, field, message });
});

export const checkContinuationHome = Effect.fn("HarnessContinuation.home")(function* (
  request: ChildRequest,
  home: Option.Option<string>,
  defaultHome: Option.Option<string>,
) {
  if (Option.isNone(request.resume)) return;
  const saved = request.resume.value;
  yield* checkContinuation(request, "cwd", Option.some(saved.cwd), Option.some(request.cwd));
  yield* checkContinuation(
    request,
    "home",
    Option.orElse(saved.home, () => defaultHome),
    home,
  );
});

export const environmentHome = (
  environment: Readonly<Record<string, string | undefined>>,
  variable: string,
  directory: string,
) => {
  const configured = (name: string) =>
    Option.fromNullishOr(environment[name]).pipe(Option.filter((value) => value.length > 0));
  const defaultHome = Option.map(configured("HOME"), (home) => `${home}/${directory}`);
  return {
    defaultHome,
    home: Option.orElse(configured(variable), () => defaultHome),
  };
};

/** The instruction used whenever interrupted work needs another turn. */
export const CONTINUATION_MESSAGE =
  "usine resumed this saved conversation after an interruption. Check the checkout and the results of any commands or tool calls you started before repeating work. Continue the task and return your final report. If the task is complete, return the final report again.";

const CONTINUATION_WINDOW = 10 * 60 * 1_000;
const MAX_CONTINUATIONS = 3;

export interface ContinuationState {
  readonly held: boolean;
  readonly paused: boolean;
  readonly idle: boolean;
  /** Native history confirms that no task input was saved. */
  readonly empty?: boolean;
}

/** Decides whether recovery needs a turn, without spending a child-session budget slot. */
export const continuationPlan = (
  session: ChildSession,
  state: ContinuationState,
  history: ReadonlyArray<number>,
  now: number,
): Result.Result<
  { readonly continue: boolean; readonly history: ReadonlyArray<number> },
  ContinuationLimitError
> => {
  const recent = history.filter((at) => now - at < CONTINUATION_WINDOW);
  if (state.held || state.paused || state.idle)
    return Result.succeed({ continue: false, history: recent });
  if (recent.length >= MAX_CONTINUATIONS)
    return Result.fail(
      ContinuationLimitError.make({
        sessionId: session.id,
        message: "The child reached its limit of three continuations within ten minutes",
      }),
    );
  return Result.succeed({ continue: true, history: [...recent, now] });
};

export interface ContinuationPolicy {
  readonly reopen: <A, R>(
    native: Effect.Effect<A, AgentSessionError, R>,
  ) => Effect.Effect<A, AgentSessionError, R>;
  readonly recover: (
    state: ContinuationState,
    tools: ReadonlyArray<InterruptedTool>,
    unread: ReadonlyArray<QueuedOperatorMessage>,
    emit: (event: AgentSessionEvent) => Effect.Effect<void>,
    send: RunningSession["steer"],
  ) => Effect.Effect<void, AgentSessionError>;
}

const makePolicy = Effect.fn("HarnessContinuation.make")(function* (request: ChildRequest) {
  const journal = yield* ChildSessionJournal.current;
  let history = request.continuations;
  return {
    reopen: <A, R>(native: Effect.Effect<A, AgentSessionError, R>) =>
      native.pipe(
        Effect.catchTag("SessionOperationError", (error) =>
          Effect.logWarning("Native child resume failed", {
            sessionId: request.session.id,
            message: error.message,
          }).pipe(
            Effect.andThen(
              SessionInterruptedError.make({
                sessionId: request.session.id,
                message: `The saved native conversation could not be reopened: ${error.message}`,
                cause: Option.some(error),
              }),
            ),
          ),
        ),
      ),
    recover: Effect.fn("HarnessContinuation.recover")(function* (state, tools, unread, emit, send) {
      yield* Effect.annotateCurrentSpan({ sessionId: request.session.id });
      for (const tool of tools)
        yield* emit(
          ToolFinished.make({
            session: request.session,
            ...tool,
            output: "The session was interrupted before this call returned",
            isError: true,
          }),
        );
      const now = yield* Clock.currentTimeMillis;
      const plan = yield* Effect.fromResult(
        continuationPlan(request.session, state, history, now),
      ).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Child continuation refused", {
            sessionId: error.sessionId,
            message: error.message,
          }),
        ),
      );
      if (!plan.continue) {
        yield* Effect.logInfo("Recovered child waits for operator guidance", {
          sessionId: request.session.id,
          ...state,
          unread: unread.length,
        });
        return;
      }
      yield* journal.continued(plan.history);
      history = plan.history;
      yield* Effect.logInfo("Continuing interrupted child work", {
        sessionId: request.session.id,
        continuations: history.length,
        tools: tools.length,
        unread: unread.length,
      });
      yield* send(state.empty === true ? request.prompt : CONTINUATION_MESSAGE);
      for (const message of unread) yield* send(message.message, message.id);
    }),
  } satisfies ContinuationPolicy;
});

export interface NativeSession extends ReopenedSession {
  readonly recover: (
    tools: ReadonlyArray<InterruptedTool>,
  ) => Effect.Effect<void, AgentSessionError>;
}

export interface ChildAdapter {
  readonly open: (
    request: ChildRequest,
    prompt: Option.Option<string>,
    policy: ContinuationPolicy,
  ) => Effect.Effect<NativeSession, AgentSessionError, Scope.Scope>;
  readonly stop: ChildBackendService["stop"];
}

/** Keeps native reopening separate from continuation decisions for every harness. */
export const childContinuation = (
  adapter: ChildAdapter,
): ChildBackendService & Pick<HarnessRuntime, "resume"> => {
  const reopen = Effect.fn("HarnessContinuation.reopen")(function* (
    request: ChildRequest,
    reference: HarnessSession,
    policy: ContinuationPolicy,
  ) {
    yield* Effect.annotateCurrentSpan({
      sessionId: request.session.id,
      harnessSessionId: reference.id,
    });
    const parent = yield* Effect.scope;
    const scope = yield* Scope.fork(parent);
    return yield* adapter
      .open(
        ChildRequest.make({ ...request, resume: Option.some(reference) }),
        Option.none(),
        policy,
      )
      .pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        Effect.asSome,
        Effect.catchTag("SessionOperationError", (error) =>
          Effect.logWarning("Saved native conversation could not be reopened", {
            sessionId: request.session.id,
            message: error.message,
          }).pipe(Effect.as(Option.none<NativeSession>())),
        ),
      );
  });
  return {
    stop: adapter.stop,
    resume: Effect.fn("HarnessContinuation.resume")(function* (request, reference) {
      const policy = yield* makePolicy(request);
      return yield* reopen(request, reference, policy);
    }),
    launch: Effect.fn("HarnessContinuation.launch")(function* (request) {
      yield* Effect.annotateCurrentSpan({ sessionId: request.session.id });
      const policy = yield* makePolicy(request);
      if (Option.isNone(request.resume))
        return (yield* adapter.open(request, Option.some(request.prompt), policy)).running;
      const reopened = yield* reopen(request, request.resume.value, policy);
      if (Option.isNone(reopened))
        return yield* SessionInterruptedError.make({
          sessionId: request.session.id,
          message: "The saved native conversation is unavailable",
        });
      const { running, active, recover } = reopened.value;
      if (!active) yield* recover(request.inFlight);
      return running;
    }),
  };
};
