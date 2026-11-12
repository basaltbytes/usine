import { Clock, Effect, Option, Result, Scope, Exit } from "effect";
import {
  type AgentSession,
  type AgentSessionEvent,
  type HarnessSession,
  ToolFinished,
} from "@usine/core/agent/session";
import {
  type ChildBackendService,
  ChildRequest,
  ChildSessionJournal,
  ContinuationLimitError,
  ContinuationMismatchError,
  SessionInterruptedError,
  type AgentSessionError,
  type InterruptedTool,
  type QueuedOperatorMessage,
  type RestartState,
  type RunningSession,
} from "../runtime.ts";
import {
  type NativeSession,
  type SessionSpec,
  type Start,
  StartPrompt,
  StartResume,
} from "./contract.ts";
import { startReference } from "./adapter.ts";
import type { HarnessCatalog } from "./harness.ts";
import { admitChild, childAdmissionContext, childRestart, childSpec } from "./launch.ts";
import type { HarnessRuntime } from "./runtime.ts";

export const checkContinuation = Effect.fn("HarnessContinuation.check")(function* (
  spec: SessionSpec,
  field: ContinuationMismatchError["field"],
  saved: Option.Option<string>,
  current: Option.Option<string>,
) {
  const sessionId = spec.session.id;
  yield* Effect.annotateCurrentSpan({ sessionId, field });
  if (Option.getOrNull(saved) === Option.getOrNull(current)) return;
  const message = `Cannot resume ${spec.session.brain.harness}: ${field} mismatch (saved ${Option.getOrElse(saved, () => "default")}, current ${Option.getOrElse(current, () => "default")})`;
  yield* Effect.logWarning("Saved child continuation refused", { sessionId, field, message });
  return yield* ContinuationMismatchError.make({ sessionId, field, message });
});

/** Refuses to reopen a saved conversation from another checkout or harness home. */
export const checkContinuationHome = Effect.fn("HarnessContinuation.home")(function* (
  spec: SessionSpec,
  start: Start,
  home: Option.Option<string>,
  defaultHome: Option.Option<string>,
) {
  const reference = startReference(start);
  if (Option.isNone(reference)) return;
  const saved = reference.value;
  yield* checkContinuation(spec, "cwd", Option.some(saved.cwd), Option.some(spec.cwd));
  yield* checkContinuation(
    spec,
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
  session: AgentSession,
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

/**
 * The continuation decorator's part of an open session: the state restored from before a restart,
 * and the decisions for reopening and recovering the native conversation.
 */
export interface ContinuationPolicy {
  readonly restored: RestartState;
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

/**
 * Makes the continuation policy of `spec`. `task` is the first input that recovery sends when the
 * native history confirms that no input was saved.
 */
export const continuationPolicy = Effect.fn("HarnessContinuation.make")(function* (
  spec: SessionSpec,
  task: string,
  restored: RestartState,
) {
  const journal = yield* ChildSessionJournal.current;
  const session = spec.session;
  let history = restored.continuations;
  return {
    restored,
    reopen: <A, R>(native: Effect.Effect<A, AgentSessionError, R>) =>
      native.pipe(
        Effect.catchTag("SessionOperationError", (error) =>
          Effect.logWarning("Native child resume failed", {
            sessionId: session.id,
            message: error.message,
          }).pipe(
            Effect.andThen(
              SessionInterruptedError.make({
                sessionId: session.id,
                message: `The saved native conversation could not be reopened: ${error.message}`,
                cause: Option.some(error),
              }),
            ),
          ),
        ),
      ),
    recover: Effect.fn("HarnessContinuation.recover")(function* (state, tools, unread, emit, send) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      for (const tool of tools)
        yield* emit(
          ToolFinished.make({
            session,
            ...tool,
            output: "The session was interrupted before this call returned",
            isError: true,
          }),
        );
      const now = yield* Clock.currentTimeMillis;
      const plan = yield* Effect.fromResult(continuationPlan(session, state, history, now)).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Child continuation refused", {
            sessionId: error.sessionId,
            message: error.message,
          }),
        ),
      );
      if (!plan.continue) {
        yield* Effect.logInfo("Recovered child waits for operator guidance", {
          sessionId: session.id,
          ...state,
          unread: unread.length,
        });
        return;
      }
      yield* journal.continued(plan.history);
      history = plan.history;
      yield* Effect.logInfo("Continuing interrupted child work", {
        sessionId: session.id,
        continuations: history.length,
        tools: tools.length,
        unread: unread.length,
      });
      yield* send(state.empty === true ? task : CONTINUATION_MESSAGE);
      for (const message of unread) yield* send(message.message, message.id);
    }),
  } satisfies ContinuationPolicy;
});

/** The child role over a harness runtime: launch, saved-conversation resume, and stop. */
export interface ChildSessions extends ChildBackendService {
  /** Reopens a saved conversation without sending a prompt; `None` means it was unavailable. */
  readonly resume: (
    request: ChildRequest,
    reference: HarnessSession,
  ) => Effect.Effect<Option.Option<NativeSession>, AgentSessionError, Scope.Scope>;
}

/**
 * Builds child sessions over `runtime`: admits each request with `catalog`, turns it into a session
 * spec and its restart state, and keeps native reopening separate from continuation decisions.
 */
export const childContinuation = (
  catalog: HarnessCatalog,
  runtime: Pick<HarnessRuntime, "open" | "stop">,
): ChildSessions => {
  const reopen = Effect.fn("HarnessContinuation.reopen")(function* (
    spec: SessionSpec,
    reference: HarnessSession,
    policy: ContinuationPolicy,
  ) {
    yield* Effect.annotateCurrentSpan({
      sessionId: spec.session.id,
      harnessSessionId: reference.id,
    });
    const parent = yield* Effect.scope;
    const scope = yield* Scope.fork(parent);
    return yield* runtime.open(spec, StartResume.make({ reference }), policy).pipe(
      Scope.provide(scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      Effect.asSome,
      Effect.catchTag("SessionOperationError", (error) =>
        Effect.logWarning("Saved native conversation could not be reopened", {
          sessionId: spec.session.id,
          message: error.message,
        }).pipe(Effect.as(Option.none<NativeSession>())),
      ),
    );
  });
  /** Admits `request` and returns its spec and continuation policy. */
  const prepare = Effect.fn("HarnessContinuation.prepare")(function* (request: ChildRequest) {
    const admitted = yield* admitChild(catalog, request);
    const spec = childSpec(request, admitted.context);
    const policy = yield* continuationPolicy(spec, request.prompt, childRestart(request));
    return { spec, policy };
  });
  return {
    stop: (request) => runtime.stop(childSpec(request, childAdmissionContext(catalog, request))),
    resume: Effect.fn("HarnessContinuation.resume")(function* (request, reference) {
      const { spec, policy } = yield* prepare(
        ChildRequest.make({ ...request, resume: Option.some(reference) }),
      );
      return yield* reopen(spec, reference, policy);
    }),
    launch: Effect.fn("HarnessContinuation.launch")(function* (request) {
      yield* Effect.annotateCurrentSpan({ sessionId: request.session.id });
      const { spec, policy } = yield* prepare(request);
      if (Option.isNone(request.resume))
        return (yield* runtime.open(spec, StartPrompt.make({ text: request.prompt }), policy))
          .running;
      const reopened = yield* reopen(spec, request.resume.value, policy);
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
