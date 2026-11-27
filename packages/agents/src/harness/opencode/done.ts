import { BackgroundWork } from "@usine/core/agent/session";
import { Effect, FiberSet, Option, Ref } from "effect";
import type { AgentSessionError, SessionOperationError } from "../../runtime.ts";
import { query } from "./api.ts";
import { ActiveSessions, Inbox, type Job, Jobs } from "./codec.ts";
import type { OpenCodeContext, OpenCodeState } from "./context.ts";
import { answerDue, Execution, runningWork, unread } from "./state.ts";

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

/** Returns the done check of the session that `context` describes. */
export const doneCheck = (context: OpenCodeContext): DoneCheck => {
  const { sessionId, root, state, api, conversation, channel, tasks, fail } = context;
  const sessionPath = `/api/session/${encodeURIComponent(root)}`;

  /**
   * Returns how many inputs OpenCode hasn't delivered, of those the session posted and those
   * OpenCode queued, and records that the answer of the execution that just succeeded waits for
   * them when there are any.
   */
  const holdForInput = Ref.modify(state, (latest): readonly [number, OpenCodeState] => {
    const count = unread(latest.pending);
    return count > 0 && latest.execution._tag === "Idle"
      ? [count, { ...latest, execution: Execution.AwaitingInput() }]
      : [count, latest];
  });

  const answerIfDue = Effect.gen(function* () {
    const due = yield* Ref.modify(state, (latest) => {
      const [isDue, execution] = answerDue(latest.execution, latest.pending);
      return [isDue, { ...latest, execution }];
    });
    if (!due) return;
    yield* Effect.logInfo("The input that the answer waited for won't start an execution", {
      sessionId,
    });
    yield* FiberSet.run(tasks, Effect.suspend(() => executionSucceeded).pipe(Effect.catch(fail)));
  });

  /** Returns the latest answer unless the session has input that OpenCode hasn't delivered. */
  const finishAnswer = Effect.flatMap(Ref.get(state), ({ lastText }) =>
    conversation.finishUnlessUnread(
      Option.getOrElse(lastText, () => "OpenCode finished without an answer"),
      holdForInput,
    ),
  );

  /** Reports the background work snapshot `work`. */
  const reportWork = (work: ReadonlyArray<BackgroundWork>) =>
    Ref.update(state, (latest) => ({ ...latest, workReported: work.length > 0 })).pipe(
      Effect.andThen(conversation.reportBackground(Option.some(work))),
    );

  /**
   * Reports the tree's background work after the root execution succeeded, by the events that
   * the runtime handled and then by OpenCode's own lists. Returns whether the answer is due:
   * false when OpenCode has unread input or runs the session's next execution.
   */
  const checkWork = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId });
    const running = runningWork((yield* Ref.get(state)).pending);
    if (running.length > 0) {
      yield* reportWork(running);
      return true;
    }
    // Work that ended just before the execution may not have queued its notice yet. OpenCode
    // queues the notice before it ends the job, so the job list, then the inbox, then the active
    // executions show the work, its notice, or the execution that the notice started.
    const latestApi = yield* api;
    const jobs = yield* latestApi.read(
      Jobs,
      "stream",
      "GET",
      `/api/experimental/job?${query("sessionID", root)}&descendants=true&status=running`,
    );
    if (jobs.data.length > 0) {
      yield* reportWork(jobs.data.map(backgroundWork));
      return true;
    }
    const inbox = yield* latestApi.read(Inbox, "stream", "GET", `${sessionPath}/inbox`);
    if (inbox.data.length > 0) {
      yield* Effect.logInfo("OpenCode has unread input, which starts the next execution", {
        sessionId,
        unread: inbox.data.length,
      });
      return false;
    }
    const { data: activeSessions } = yield* latestApi.read(
      ActiveSessions,
      "stream",
      "GET",
      "/api/session/active",
    );
    if (Object.hasOwn(activeSessions, root)) {
      yield* Effect.logInfo("OpenCode started the session's next execution", { sessionId });
      return false;
    }
    yield* reportWork([]);
    return true;
  }).pipe(Effect.withSpan("OpenCodeRuntime.checkWork"));

  const executionSucceeded = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId });
    const unreadCount = yield* holdForInput;
    if (unreadCount > 0)
      return yield* Effect.logInfo(
        "OpenCode's execution ended with input that it hasn't delivered, which starts the next execution",
        { sessionId, unread: unreadCount },
      );
    if (yield* checkWork) yield* finishAnswer;
  }).pipe(Effect.withSpan("OpenCodeRuntime.executionSucceeded"));

  const workEnded = Effect.gen(function* () {
    const { execution, workReported } = yield* Ref.get(state);
    if (!workReported || execution._tag !== "Idle" || (yield* channel.isTerminal)) return;
    yield* Effect.logInfo("Background work that the answer waits for ended; checking the rest", {
      sessionId,
    });
    yield* checkWork;
  }).pipe(Effect.withSpan("OpenCodeRuntime.workEnded"));

  return { executionSucceeded, answerIfDue, workEnded };
};
