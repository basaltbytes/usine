import {
  ProviderAnswered,
  ProviderRecovered,
  ProviderRetries,
  ProviderRetrying,
  SessionTokensUpdated,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { capacityBackoff } from "@usine/core/attempt";
import { Effect, FiberSet, Option, Ref } from "effect";
import { AgentResultError, type AgentSessionError } from "../../runtime.ts";
import {
  addUsage,
  capacityFailure,
  distantRetry,
  type HandledEvent,
  type OpenCodeTokens,
  type SessionEvent,
  type ShellEvent,
  tokenBreakdown,
  totalTokens,
} from "./codec.ts";
import {
  type OpenCodeContext,
  type OpenCodeState,
  type OperatorIds,
  updatePending,
} from "./context.ts";
import type { DoneCheck } from "./done.ts";
import {
  cancelled,
  childCreated,
  childRunning,
  delivered,
  enqueued,
  Execution,
  executionInterrupted,
  type InputsEnded,
  type InterruptIntent,
  inTree,
  type Pending,
  shellEnded,
  shellStarted,
} from "./state.ts";

/**
 * A retry that OpenCode schedules further ahead than usine's first wait after a capacity refusal
 * ends the session, so the attempt waits for capacity instead of OpenCode.
 */
const RETRY_THRESHOLD = capacityBackoff(1);

/** What the event handlers of an OpenCode session call outside themselves. */
export interface EventActions {
  readonly done: DoneCheck;
  readonly operatorIds: Ref.Ref<OperatorIds>;
  /**
   * Applies `end`, which records an answered, failed, or cancelled input, and returns the answer
   * that waited for the inputs that OpenCode won't deliver.
   */
  readonly endInputs: (end: (pending: Pending) => InputsEnded) => Effect.Effect<void>;
  /** Ends the turn that `session.execution.interrupted` with `reason` interrupted. */
  readonly endInterrupted: (
    reason: string,
    intent: Option.Option<InterruptIntent>,
  ) => Effect.Effect<void, AgentSessionError>;
  /** Pauses the running execution. */
  readonly pause: Effect.Effect<void, AgentSessionError>;
}

/** Returns the handler of the OpenCode events of the session that `context` describes. */
export const openCodeEvents = (context: OpenCodeContext, actions: EventActions) => {
  const { sessionId, root, session, state, api, conversation, channel, tasks, fail } = context;
  const { done, operatorIds, endInputs, endInterrupted, pause } = actions;

  const reportModelOutput = Effect.fn("OpenCodeRuntime.reportModelOutput")(function* () {
    const latest = yield* Ref.getAndUpdate(state, (value) => ({
      ...value,
      retrying: false,
      answered: true,
    }));
    if (latest.retrying) {
      yield* Effect.logInfo("OpenCode reached its provider again", {
        sessionId,
        retries: latest.retries,
      });
      yield* channel.emit(
        ProviderRecovered.make({ session, retries: ProviderRetries.make(latest.retries) }),
      );
    }
    if (latest.answered) return;
    yield* Effect.logInfo("OpenCode got its provider's first answer since the bridge started", {
      sessionId,
    });
    yield* channel.emit(ProviderAnswered.make({ session }));
  });

  /** Sets the command environment of child session `child`, so its tool commands get the worker's. */
  const childEnvironment = (child: string) =>
    Effect.flatMap(api, (latestApi) => latestApi.setToolEnvironment("stream", child)).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "Could not set the command environment of an OpenCode child session; its commands get OpenCode's directories",
          { sessionId, childSessionId: child, message: error.message },
        ),
      ),
    );

  /** Handles an event of a shell, which counts as background work while it runs. */
  const handleShell = (event: ShellEvent) =>
    event.type === "shell.created"
      ? updatePending(state, (pending) =>
          Option.match(Option.fromUndefinedOr(event.data.info.metadata.sessionID), {
            onNone: () => pending,
            onSome: (session) =>
              shellStarted(pending, root, {
                id: event.data.info.id,
                command: event.data.info.command,
                session,
              }),
          }),
        )
      : updatePending(state, (pending) => shellEnded(pending, event.data.id)).pipe(
          Effect.andThen(done.workEnded),
        );

  /** Handles an event of a child session: its creation, executions, and usage. */
  const handleChild = Effect.fn("OpenCodeRuntime.handleChild")(function* (event: SessionEvent) {
    const child = event.data.sessionID;
    switch (event.type) {
      case "session.created": {
        const { parentID, title } = event.data;
        if (parentID === undefined) return;
        const created = yield* Ref.modify(state, (latest) =>
          Option.match(
            childCreated(latest.pending, root, { id: child, parent: parentID, title: title ?? "" }),
            {
              onNone: () => [false, latest],
              onSome: (pending) => [true, { ...latest, pending }],
            },
          ),
        );
        if (!created) return;
        yield* Effect.logInfo("OpenCode started a child session", {
          sessionId,
          childSessionId: child,
        });
        return yield* FiberSet.run(tasks, childEnvironment(child)).pipe(Effect.asVoid);
      }
      case "session.execution.started":
        return yield* updatePending(state, (pending) => childRunning(pending, child, true));
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        yield* updatePending(state, (pending) => childRunning(pending, child, false));
        return yield* done.workEnded;
      default:
        return;
    }
  });

  /** Records the usage of `owner`, a session of the tree, and reports the tree's total. */
  const reportUsage = Effect.fn("OpenCodeRuntime.reportUsage")(function* (
    owner: string,
    cost: number,
    tokens: OpenCodeTokens,
  ) {
    const { usage } = yield* Ref.updateAndGet(state, (latest) => ({
      ...latest,
      usage: new Map(latest.usage).set(owner, { cost, tokens }),
    }));
    const total = addUsage([...usage.values()]);
    yield* channel.emit(
      SessionTokensUpdated.make({
        session,
        totalTokens: totalTokens(total.tokens),
        costUsd: Option.some(total.cost),
        breakdown: Option.some(tokenBreakdown(total.tokens)),
      }),
    );
  });

  const handle = Effect.fn("OpenCodeRuntime.handle")(function* (event: HandledEvent) {
    if (
      event.type === "shell.created" ||
      event.type === "shell.exited" ||
      event.type === "shell.deleted"
    )
      return yield* handleShell(event);
    const { pending } = yield* Ref.get(state);
    if (!inTree(pending, root, event.data.sessionID) && event.type !== "session.created") return;
    if (event.type === "session.usage.updated")
      return yield* reportUsage(event.data.sessionID, event.data.cost, event.data.tokens);
    if (event.data.sessionID !== root) return yield* handleChild(event);
    switch (event.type) {
      case "session.execution.started": {
        const { execution } = yield* Ref.getAndUpdate(state, (latest): OpenCodeState => ({
          ...latest,
          execution: Execution.Running(),
          executions: latest.executions + 1,
          lastText: Option.none(),
          retries: 0,
          retrying: false,
        }));
        if (execution._tag === "AwaitingSuccessor")
          yield* Effect.logInfo(
            "A successor execution reads the steer after the interrupt and ends the turn",
            { sessionId },
          );
        yield* conversation.turnStarted;
        if (!(yield* conversation.isPaused)) return;
        // The operator paused the session between executions, such as while input was pending.
        yield* Effect.logInfo("OpenCode started an execution of the paused session; pausing it", {
          sessionId,
        });
        return yield* FiberSet.run(
          tasks,
          pause.pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not pause OpenCode's execution", {
                sessionId,
                message: error.message,
              }),
            ),
          ),
        ).pipe(Effect.asVoid);
      }
      case "session.inbox.enqueued":
        return yield* updatePending(state, (latest) => enqueued(latest, event.data.inboxID));
      case "session.inbox.cancelled":
        yield* Effect.logInfo("OpenCode cancelled an input that the session hadn't read", {
          sessionId,
          inboxId: event.data.inboxID,
        });
        return yield* endInputs((latest) => cancelled(latest, event.data.inboxID));
      case "session.inbox.delivered": {
        const operator = (yield* Ref.get(operatorIds)).get(event.data.inboxID);
        yield* Ref.update(state, (latest): OpenCodeState => ({
          ...latest,
          pending: delivered(latest.pending, event.data.inboxID, latest.execution),
        }));
        if (operator === undefined) return;
        yield* conversation.observe(operator);
        return;
      }
      case "session.text.ended": {
        const text = event.data.text.trim();
        if (text.length === 0) return;
        yield* Ref.update(state, (latest) => ({ ...latest, lastText: Option.some(text) }));
        return yield* channel.emit(TextOutput.make({ session, text }));
      }
      case "session.tool.input.started": {
        const { id: callId, name } = event.data;
        return yield* Ref.update(state, (latest) => ({
          ...latest,
          toolNames: new Map(latest.toolNames).set(callId, name),
        }));
      }
      case "session.tool.called": {
        const callId = event.data.id;
        const tool = (yield* Ref.get(state)).toolNames.get(callId) ?? "unknown";
        yield* Ref.update(state, (latest) => ({
          ...latest,
          toolsInFlight: new Map(latest.toolsInFlight).set(callId, tool),
        }));
        return yield* channel.emit(
          ToolStarted.make({ session, callId, tool, input: event.data.input }),
        );
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const callId = event.data.id;
        const tool = yield* Ref.modify(state, (latest) => {
          const toolsInFlight = new Map(latest.toolsInFlight);
          const name = toolsInFlight.get(callId) ?? latest.toolNames.get(callId) ?? "unknown";
          toolsInFlight.delete(callId);
          const toolNames = new Map(latest.toolNames);
          toolNames.delete(callId);
          return [name, { ...latest, toolsInFlight, toolNames }];
        });
        return yield* channel.emit(
          ToolFinished.make({
            session,
            callId,
            tool,
            output:
              event.type === "session.tool.success"
                ? event.data.content
                : { type: event.data.error.type, message: event.data.error.message },
            isError: event.type === "session.tool.failed",
          }),
        );
      }
      case "session.step.ended":
        return yield* reportModelOutput();
      case "session.retry.scheduled": {
        const capacity = distantRetry(sessionId, event.data, RETRY_THRESHOLD);
        if (Option.isSome(capacity)) {
          yield* Effect.logWarning(
            "OpenCode's provider retry is too far ahead; ending the session",
            {
              sessionId,
              retryAfterMs: event.data.error.retryAfterMs,
              type: event.data.error.type,
            },
          );
          return yield* fail(capacity.value);
        }
        const retries = yield* Ref.modify(state, (latest) => [
          latest.retries + 1,
          { ...latest, retries: latest.retries + 1, retrying: true },
        ]);
        yield* Effect.logWarning("OpenCode can't reach its provider and will retry", {
          sessionId,
          retries,
          attempt: event.data.attempt,
          retryAfterMs: event.data.error.retryAfterMs,
          type: event.data.error.type,
        });
        return yield* channel.emit(
          ProviderRetrying.make({
            session,
            message: event.data.error.message || event.data.error.type,
            retries: ProviderRetries.make(retries),
          }),
        );
      }
      case "session.execution.succeeded":
        yield* Ref.update(state, (latest): OpenCodeState => ({
          ...latest,
          execution: Execution.Idle(),
        }));
        return yield* done.executionSucceeded;
      case "session.execution.failed": {
        yield* Ref.update(state, (latest): OpenCodeState => ({
          ...latest,
          execution: Execution.Idle(),
        }));
        const { error } = event.data;
        yield* Effect.logWarning("OpenCode's execution failed", {
          sessionId,
          type: error.type,
          message: error.message,
        });
        return yield* fail(
          Option.getOrElse(capacityFailure(sessionId, error), () =>
            AgentResultError.make({
              sessionId: Option.some(sessionId),
              message: `OpenCode's execution failed (${error.type}): ${error.message}`,
            }),
          ),
        );
      }
      case "session.execution.interrupted": {
        const { reason } = event.data;
        const outcome = yield* Ref.modify(state, (latest) => {
          const [ended, execution] = executionInterrupted(latest.execution, reason, latest.pending);
          return [ended, { ...latest, execution }];
        });
        if (outcome._tag === "Deferred")
          return yield* Effect.logInfo(
            "A steer posted after the interrupt keeps the turn open for its successor execution",
            { sessionId, undelivered: outcome.late.length },
          );
        return yield* endInterrupted(reason, outcome.intent);
      }
      case "session.created":
        return;
    }
  });

  return handle;
};
