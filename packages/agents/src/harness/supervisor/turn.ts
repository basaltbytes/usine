import { BrainSpec } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  type AgentSessionEvent,
  HarnessSession,
  RoleSession,
  SessionTokensUpdated,
  ToolFinished,
} from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { Array as Arr, type Brand, Effect, Fiber, Option, Result, Schema, Stream } from "effect";
import type { Tool, Toolkit } from "effect/ai";
import { ChildHost } from "../../child-host/child-host.ts";
import {
  AgentResultError,
  AgentSessionError,
  RestartState,
  WorkingDirectory,
} from "../../runtime.ts";
import { CredentialRoute } from "../capability.ts";
import { type ContinuationPolicy, continuationPolicy } from "../continuation.ts";
import { SessionSpec, StartPrompt, StartResume } from "../contract.ts";
import { Harnesses } from "../registry.ts";
import { admitSupervisor, supervisor, supervisorAgent } from "./role.ts";

/** Where supervisor sessions run on the orchestrator, and the credential route they use. */
export class SupervisorSeat extends Schema.Class<
  SupervisorSeat,
  Brand.Brand<"@usine/agents/harness/supervisor/SupervisorSeat">
>("@usine/agents/SupervisorSeat")({
  host: ChildHost,
  /** The worker name that the session's process and logs carry. */
  worker: WorkerName,
  /** The directory that the conversation's harness process starts in. */
  cwd: WorkingDirectory,
  /** The complete environment of the harness process, with the gateway credential (ADR 0011). */
  environment: Schema.Record(Schema.String, Schema.String),
  credential: CredentialRoute,
}) {}

/** One member message to a supervisor conversation. */
export class SupervisorTurn extends Schema.Class<
  SupervisorTurn,
  Brand.Brand<"@usine/agents/harness/supervisor/SupervisorTurn">
>("@usine/agents/SupervisorTurn")({
  /** The usine session ID of the conversation, the same on every turn. */
  session: AgentSessionId,
  brain: BrainSpec,
  seat: SupervisorSeat,
  /** The session that the previous turn saved, or `None` for the conversation's first turn. */
  saved: Schema.Option(HarnessSession),
  /**
   * The session's usage that the previous turn returned or failed with, which this turn's usage
   * continues, or `None` for the conversation's first turn.
   */
  usage: Schema.Option(SessionTokensUpdated),
  message: Schema.NonEmptyString,
}) {}

/** A supervisor turn that returned no answer, with the usage that the session had spent. */
export class SupervisorTurnError extends Schema.TaggedError<
  SupervisorTurnError,
  Brand.Brand<"@usine/agents/harness/supervisor/SupervisorTurnError">
>("@usine/agents/SupervisorTurnError")("SupervisorTurnError", {
  sessionId: AgentSessionId,
  reason: AgentSessionError,
  /**
   * The session's cumulative usage when the turn failed: the turn's last report, or the turn's
   * starting usage when it reported none.
   */
  usage: Schema.Option(SessionTokensUpdated),
  /** The message of `reason`. */
  message: Schema.NonEmptyString,
}) {}

/** What a supervisor turn returns. */
export interface SupervisorReply {
  readonly message: string;
  /** The saved session that the conversation's next turn reopens. */
  readonly saved: HarnessSession;
  /**
   * The session's cumulative tokens and cost across the conversation's turns, reported as for any
   * session, with the brain that ran and the billing pool that paid; `None` when no turn reported
   * usage.
   */
  readonly usage: Option.Option<SessionTokensUpdated>;
  /** The turn's session events, in order. */
  readonly events: ReadonlyArray<AgentSessionEvent>;
}

/**
 * The continuation policy of a turn that reopens the saved session: reopening closes any tool
 * call that the previous turn left open and sends the member's message as the next turn.
 */
const nextTurnPolicy = (
  spec: SessionSpec,
  base: ContinuationPolicy,
  message: string,
): ContinuationPolicy => ({
  ...base,
  recover: Effect.fn("Supervisor.nextTurn")(function* (_state, tools, _unread, emit, send) {
    for (const tool of tools)
      yield* emit(
        ToolFinished.make({
          session: spec.session,
          ...tool,
          output: "The session was interrupted before this call returned",
          isError: true,
        }),
      );
    yield* Effect.logInfo("Sending the next supervisor turn to the reopened session", {
      sessionId: spec.session.id,
      interruptedTools: tools.length,
    });
    yield* send(message);
  }),
});

/** The last usage report among `events`. */
const lastUsage = (events: ReadonlyArray<AgentSessionEvent>) =>
  Arr.findLast(
    events,
    (event): event is SessionTokensUpdated => event._tag === "SessionTokensUpdated",
  );

/**
 * Runs one turn of a supervisor conversation through `Harnesses`: admits the brain as the
 * supervisor, opens a session that serves `tools` with the handlers of the calling context, or
 * reopens the saved session and sends the message, and returns the answer once the turn ends.
 * The turn's usage continues `turn.usage`. The session closes when the turn ends.
 */
export const runSupervisorTurn = Effect.fn("Supervisor.turn")(function* <
  Tools extends Record<string, Tool.Any>,
>(turn: SupervisorTurn, tools: Toolkit.Toolkit<Tools>) {
  const { brain, seat } = turn;
  const resume = Option.isSome(turn.saved);
  const events: Array<AgentSessionEvent> = [];
  const failed = (reason: AgentSessionError) =>
    SupervisorTurnError.make({
      sessionId: turn.session,
      reason,
      usage: Option.orElse(lastUsage(events), () => turn.usage),
      message: reason.message,
    });
  yield* Effect.annotateCurrentSpan({
    sessionId: turn.session,
    harness: brain.harness,
    model: brain.model,
    resume,
  });
  const harnesses = yield* Harnesses;
  const admitted = admitSupervisor(harnesses.catalog, brain, seat.credential);
  if (Result.isFailure(admitted)) {
    yield* Effect.logWarning("Supervisor brain refused", {
      sessionId: turn.session,
      harness: brain.harness,
      missing: admitted.failure.missing,
    });
    return yield* failed(
      AgentResultError.make({
        sessionId: Option.some(turn.session),
        message: admitted.failure.message,
      }),
    );
  }
  const spec = SessionSpec.make({
    session: RoleSession.make({
      id: turn.session,
      role: supervisor.name,
      agent: supervisorAgent,
      brain,
    }),
    admitted: admitted.success,
    host: seat.host,
    worker: seat.worker,
    machine: Option.none(),
    cwd: seat.cwd,
    environment: seat.environment,
  });
  const runtime = yield* harnesses.runtime(brain.harness);
  const restart = RestartState.make({
    usage: Option.map(turn.usage, ({ totalTokens, costUsd, processUsage }) => ({
      totalTokens,
      costUsd,
      processUsage,
    })),
  });
  const base = yield* continuationPolicy(spec, turn.message, restart);
  const message = yield* Effect.gen(function* () {
    const native = yield* Option.match(turn.saved, {
      onNone: () => runtime.open(spec, StartPrompt.make({ text: turn.message }), base, tools),
      onSome: (reference) =>
        runtime.open(
          spec,
          StartResume.make({ reference }),
          nextTurnPolicy(spec, base, turn.message),
          tools,
        ),
    });
    const collected = yield* Effect.forkScoped(
      Stream.runForEach(native.running.events, (event) => Effect.sync(() => events.push(event))),
    );
    if (resume) {
      if (native.active) {
        const harnessSessionId = Option.map(turn.saved, ({ id }) => id).pipe(Option.getOrUndefined);
        yield* Effect.logWarning("Supervisor turn refused: the saved session is still running", {
          sessionId: turn.session,
          harnessSessionId,
        });
        return yield* AgentResultError.make({
          sessionId: Option.some(turn.session),
          message: "The supervisor's saved session is still running a turn",
        });
      }
      yield* native.recover([]);
    }
    // A failed session ends its events after the last report, so the failure keeps its usage.
    const result = yield* native.running.result.pipe(Effect.tapError(() => Fiber.await(collected)));
    yield* Fiber.join(collected);
    return result.message;
  }).pipe(Effect.scoped, Effect.mapError(failed));
  const saved = Option.firstSomeOf(
    events.map((event) => (event._tag === "SessionStarted" ? event.harnessSession : Option.none())),
  );
  if (Option.isNone(saved)) {
    yield* Effect.logError("Supervisor session saved no conversation", {
      sessionId: turn.session,
      harness: brain.harness,
    });
    return yield* failed(
      AgentResultError.make({
        sessionId: Option.some(turn.session),
        message: `${brain.harness} saved no conversation for the supervisor's next turn`,
      }),
    );
  }
  const usage = Option.orElse(lastUsage(events), () => turn.usage);
  yield* Effect.logInfo("Supervisor turn finished", {
    sessionId: turn.session,
    harness: brain.harness,
    resumed: resume,
    harnessSessionId: saved.value.id,
    ...Option.match(usage, {
      onNone: () => ({}),
      onSome: ({ totalTokens, session }) => ({
        totalTokens,
        ...Option.match(session.pool, { onNone: () => ({}), onSome: (pool) => ({ pool }) }),
      }),
    }),
  });
  return {
    message,
    saved: saved.value,
    usage,
    events,
  } satisfies SupervisorReply;
});
