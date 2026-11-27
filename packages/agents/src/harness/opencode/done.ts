import { BackgroundWork } from "@usine/core/agent/session";
import { retryTransient } from "@usine/core/retry";
import { Duration, Effect, FiberSet, Option, Ref, Schema } from "effect";
import { ChildProcessLost } from "../../child-host/process.ts";
import { RequestTimedOut } from "../../child-host/requests.ts";
import { type AgentSessionError, SessionOperationError } from "../../runtime.ts";
import { query } from "./api.ts";
import { BridgeAnswer } from "./bridge/lines.ts";
import { ActiveSessions, Inbox, type Job, Jobs } from "./codec.ts";
import type { OpenCodeContext, OpenCodeState } from "./context.ts";
import { answerDue, Execution, runningWork, unread, workReported } from "./state.ts";

/** The check of whether an OpenCode session's answer is due, after its root execution succeeded. */
export interface DoneCheck {
  /**
   * Returns the session's answer once nothing starts another execution: no input that OpenCode
   * hasn't delivered and no running background work. Running work is reported, and the
   * conversation waits for the execution that its end starts.
   */
  readonly executionSucceeded: Effect.Effect<void, AgentSessionError>;
  /**
   * Returns the answer that waited for input once none of that input remains, such as after its
   * post failed, outside the operation that dropped it.
   */
  readonly answerIfDue: Effect.Effect<void>;
  /**
   * Reports the tree's background work again after some of it ended, while the root execution's
   * answer waits for it, so the conversation returns the answer once none is left.
   */
  readonly workEnded: Effect.Effect<void, SessionOperationError>;
}

const backgroundWork = (job: Job) =>
  BackgroundWork.make({
    id: job.id,
    kind: job.kind === "shell" ? "command" : job.kind === "subagent" ? "agent" : "other",
    description: job.title ?? job.description ?? job.command ?? "",
  });

/** Whether `error` is a 5xx answer or a request timeout, which a retry can get past. */
const isTransient = (error: SessionOperationError) =>
  Schema.is(RequestTimedOut)(error.cause) ||
  (Schema.is(BridgeAnswer)(error.cause) && error.cause.status >= 500);

/** Returns the done check of the session that `context` describes. */
export const doneCheck = (context: OpenCodeContext): DoneCheck => {
  const { sessionId, root, state, api, conversation, channel, tasks, fail } = context;
  const sessionPath = `/api/session/${encodeURIComponent(root)}`;

  /**
   * Returns how many inputs OpenCode hasn't delivered, of those the session posted and those
   * OpenCode queued, and records that the answer of execution `checked`, which succeeded, waits
   * for them when there are any. Returns `None` once OpenCode started a later execution.
   */
  const holdForInput = (checked: number) =>
    Ref.modify(state, (latest): readonly [Option.Option<number>, OpenCodeState] => {
      if (latest.executions !== checked) return [Option.none(), latest];
      const count = unread(latest.pending);
      return count > 0 &&
        (latest.execution._tag === "Idle" || latest.execution._tag === "AwaitingWork")
        ? [Option.some(count), { ...latest, execution: Execution.AwaitingInput() }]
        : [Option.some(count), latest];
    });

  /** Logs that a done check stops because OpenCode started an execution after the one it checks. */
  const superseded = (checked: number) =>
    Effect.logInfo(
      "OpenCode started another execution during the done check; that execution's check answers",
      { sessionId, execution: checked },
    );

  const answerIfDue = Effect.gen(function* () {
    const due = yield* Ref.modify(state, (latest) => {
      const [isDue, execution] = answerDue(latest.execution, latest.pending);
      return [isDue ? Option.some(latest.executions) : Option.none(), { ...latest, execution }];
    });
    if (Option.isNone(due)) return;
    yield* Effect.logInfo("The input that the answer waited for won't start an execution", {
      sessionId,
    });
    yield* FiberSet.run(tasks, Effect.suspend(() => check(due.value)).pipe(Effect.catch(fail)));
  });

  /**
   * Runs `read`, a lookup of OpenCode's `name`, and retries it twice after a 5xx answer or a
   * request timeout. A failure that remains names the lookup, unless it is the bridge's loss,
   * which a restart handles.
   */
  const lookup = <A>(name: string, read: Effect.Effect<A, SessionOperationError>) =>
    read.pipe(
      retryTransient(isTransient, ({ error, retry, delay }) =>
        Effect.logWarning("Could not read OpenCode's state for the done check; retrying", {
          sessionId,
          lookup: name,
          retry,
          delayMs: Duration.toMillis(delay),
          message: error.message,
        }),
      ),
      Effect.mapError((error) =>
        Schema.is(ChildProcessLost)(error.cause)
          ? error
          : SessionOperationError.make({
              operation: error.operation,
              sessionId: error.sessionId,
              message: `Could not read OpenCode's ${name} after its execution succeeded: ${error.message}`,
              cause: error.cause,
            }),
      ),
    );

  /**
   * Returns the latest answer as the answer of execution `checked`, unless the session has input
   * that OpenCode hasn't delivered or OpenCode started a later execution.
   */
  const finishAnswer = (checked: number) =>
    Effect.flatMap(Ref.get(state), ({ lastText }) =>
      conversation.finishUnlessUnread(
        Option.getOrElse(lastText, () => "OpenCode finished without an answer"),
        Effect.flatMap(
          holdForInput(checked),
          Option.match({
            // The later execution read input that starts another turn, which answers instead.
            onNone: () => Effect.as(superseded(checked), 1),
            onSome: Effect.succeed,
          }),
        ),
      ),
    );

  /**
   * Reports the background work snapshot `work` of execution `checked`, unless OpenCode started a
   * later execution. Returns whether it reported the snapshot.
   */
  const reportWork = Effect.fn("OpenCodeRuntime.reportWork")(function* (
    checked: number,
    work: ReadonlyArray<BackgroundWork>,
  ) {
    const latest = yield* Ref.modify(state, (latest): readonly [boolean, OpenCodeState] =>
      latest.executions === checked
        ? [true, { ...latest, execution: workReported(latest.execution, work.length > 0) }]
        : [false, latest],
    );
    if (!latest) {
      yield* superseded(checked);
      return false;
    }
    yield* conversation.reportBackground(Option.some(work));
    return true;
  });

  /**
   * Reports the tree's background work after root execution `checked` succeeded, by the events
   * that the runtime handled and then by OpenCode's own lists. Returns whether the answer is due:
   * false when OpenCode has unread input or runs the session's next execution.
   */
  const checkWork = Effect.fn("OpenCodeRuntime.checkWork")(function* (checked: number) {
    yield* Effect.annotateCurrentSpan({ sessionId, execution: checked });
    const running = runningWork((yield* Ref.get(state)).pending);
    if (running.length > 0) return yield* reportWork(checked, running);
    // Work that ended just before the execution may not have queued its notice yet. OpenCode
    // queues the notice before it ends the job, so the job list, then the inbox, then the active
    // executions show the work, its notice, or the execution that the notice started.
    const latestApi = yield* api;
    const jobs = yield* lookup(
      "running jobs",
      latestApi.read(
        Jobs,
        "stream",
        "GET",
        `/api/experimental/job?${query("sessionID", root)}&descendants=true&status=running`,
      ),
    );
    if (jobs.data.length > 0) return yield* reportWork(checked, jobs.data.map(backgroundWork));
    const inbox = yield* lookup(
      "session inbox",
      latestApi.read(Inbox, "stream", "GET", `${sessionPath}/inbox`),
    );
    if (inbox.data.length > 0) {
      yield* Effect.logInfo("OpenCode has unread input, which starts the next execution", {
        sessionId,
        unread: inbox.data.length,
      });
      return false;
    }
    const { data: activeSessions } = yield* lookup(
      "active sessions",
      latestApi.read(ActiveSessions, "stream", "GET", "/api/session/active"),
    );
    if (Object.hasOwn(activeSessions, root)) {
      yield* Effect.logInfo("OpenCode started the session's next execution", { sessionId });
      return false;
    }
    return yield* reportWork(checked, []);
  });

  /** Returns the answer of root execution `checked` once it is due, as `executionSucceeded` does. */
  const check = Effect.fn("OpenCodeRuntime.executionSucceeded")(function* (checked: number) {
    yield* Effect.annotateCurrentSpan({ sessionId, execution: checked });
    const unreadCount = yield* holdForInput(checked);
    if (Option.isNone(unreadCount)) return yield* superseded(checked);
    if (unreadCount.value > 0)
      return yield* Effect.logInfo(
        "OpenCode's execution ended with input that it hasn't delivered, which starts the next execution",
        { sessionId, unread: unreadCount.value },
      );
    if (yield* checkWork(checked)) yield* finishAnswer(checked);
  });

  const executionSucceeded = Effect.flatMap(Ref.get(state), ({ executions }) => check(executions));

  const workEnded = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId });
    const { execution, executions } = yield* Ref.get(state);
    if (execution._tag !== "AwaitingWork" || (yield* channel.isTerminal)) return;
    yield* Effect.logInfo("Background work that the answer waits for ended; checking the rest", {
      sessionId,
    });
    yield* checkWork(executions);
  }).pipe(Effect.withSpan("OpenCodeRuntime.workEnded"));

  return { executionSucceeded, answerIfDue, workEnded };
};
