import { BrainSpec } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  type AgentSessionEvent,
  HarnessSession,
  RoleSession,
  type SessionTokensUpdated,
  ToolFinished,
} from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { Array as Arr, type Brand, Effect, Fiber, Option, Result, Schema, Stream } from "effect";
import type { Tool, Toolkit } from "effect/ai";
import { ChildHost } from "../../child-host/child-host.ts";
import { AgentResultError, RestartState, WorkingDirectory } from "../../runtime.ts";
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
  message: Schema.NonEmptyString,
}) {}

/** What a supervisor turn returns. */
export interface SupervisorReply {
  readonly message: string;
  /** The saved session that the conversation's next turn reopens. */
  readonly saved: HarnessSession;
  /**
   * The session's cumulative tokens and cost, reported as for any session, with the brain that
   * ran and the billing pool that paid; `None` when the harness reported no usage.
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

/**
 * Runs one turn of a supervisor conversation through `Harnesses`: admits the brain as the
 * supervisor, opens a session that serves `tools` with the handlers of the calling context, or
 * reopens the saved session and sends the message, and returns the answer once the turn ends.
 * The session closes when the turn ends.
 */
export const runSupervisorTurn = Effect.fn("Supervisor.turn")(function* <
  Tools extends Record<string, Tool.Any>,
>(turn: SupervisorTurn, tools: Toolkit.Toolkit<Tools>) {
  const { brain, seat } = turn;
  const resume = Option.isSome(turn.saved);
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
    return yield* AgentResultError.make({
      sessionId: Option.some(turn.session),
      message: admitted.failure.message,
    });
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
  const base = yield* continuationPolicy(spec, turn.message, RestartState.make({}));
  const reply = yield* Effect.gen(function* () {
    const native = Option.isSome(turn.saved)
      ? yield* runtime.open(
          spec,
          StartResume.make({ reference: turn.saved.value }),
          nextTurnPolicy(spec, base, turn.message),
          tools,
        )
      : yield* runtime.open(spec, StartPrompt.make({ text: turn.message }), base, tools);
    const collected = yield* Effect.forkScoped(Stream.runCollect(native.running.events));
    if (resume) {
      if (native.active)
        return yield* AgentResultError.make({
          sessionId: Option.some(turn.session),
          message: "The supervisor's saved session is still running a turn",
        });
      yield* native.recover([]);
    }
    const result = yield* native.running.result;
    const events = [...(yield* Fiber.join(collected))];
    return { message: result.message, events };
  }).pipe(Effect.scoped);
  const saved = Option.firstSomeOf(
    reply.events.map((event) =>
      event._tag === "SessionStarted" ? event.harnessSession : Option.none(),
    ),
  );
  if (Option.isNone(saved)) {
    yield* Effect.logError("Supervisor session saved no conversation", {
      sessionId: turn.session,
      harness: brain.harness,
    });
    return yield* AgentResultError.make({
      sessionId: Option.some(turn.session),
      message: `${brain.harness} saved no conversation for the supervisor's next turn`,
    });
  }
  const usage = Arr.findLast(
    reply.events,
    (event): event is SessionTokensUpdated => event._tag === "SessionTokensUpdated",
  );
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
    message: reply.message,
    saved: saved.value,
    usage,
    events: reply.events,
  } satisfies SupervisorReply;
});
