import {
  AgentSession,
  BillingPool,
  brainPool,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import { type Attempt, AttemptId } from "@usine/core/attempt";
import type { RunStoreError } from "@usine/engine/engine";
import { RunReader, type RunSnapshot } from "@usine/engine/run-reader";
import { type TranscriptEntry, TranscriptUsageQuery } from "@usine/engine/transcript";
import { Context, Effect, Layer, Option, Schema } from "effect";

/**
 * Dollars a harness priced usage at. `estimate` marks the Claude plan's figure,
 * which the Agent SDK computes from its bundled prices for a subscription that
 * bills no dollars (ADR 0013).
 */
export class UsageCostView extends Schema.Class<UsageCostView>("@usine/orchestrator/UsageCostView")(
  { usd: UsdAmount, estimate: Schema.Boolean },
) {}

/** One session of one Attempt: what it used, from its highest token report, and the pool that pays. */
export class SessionUsageView extends Schema.Class<SessionUsageView>(
  "@usine/orchestrator/SessionUsageView",
)({
  attemptId: AttemptId,
  /** The parent or child, with its Agent and brain. */
  session: AgentSession,
  pool: BillingPool,
  tokens: TokenCount,
  /** Null in the ChatGPT plan, which has no dollar rate, and when the harness priced nothing. */
  cost: Schema.NullOr(UsageCostView),
}) {}

/** What a Run's sessions drew from one billing pool. */
export class PoolUsageView extends Schema.Class<PoolUsageView>("@usine/orchestrator/PoolUsageView")(
  {
    pool: BillingPool,
    tokens: TokenCount,
    /** Null in the ChatGPT plan, and when any of the pool's sessions has no price, so a partial sum never reads as the whole. */
    cost: Schema.NullOr(UsageCostView),
  },
) {}

/** The tokens a Run's Attempts have used so far, per pool and per session, with prices where a pool has a dollar rate. */
export class RunUsageView extends Schema.Class<RunUsageView>("@usine/orchestrator/RunUsageView")({
  tokens: TokenCount,
  /** Pools in the order API keys, Claude plan, ChatGPT plan; a pool no session used is absent. */
  pools: Schema.Array(PoolUsageView),
  /** Sessions in the order their Attempt began and their first report arrived. */
  sessions: Schema.Array(SessionUsageView),
}) {}

const POOLS: ReadonlyArray<BillingPool> = ["apiKeys", "claudePlan", "chatgptPlan"];

const priced = (pool: BillingPool, usd: Option.Option<UsdAmount>): UsageCostView | null =>
  pool === "chatgptPlan"
    ? null
    : Option.match(usd, {
        onNone: () => null,
        onSome: (value) => new UsageCostView({ usd: value, estimate: pool === "claudePlan" }),
      });

/**
 * Sums a Run's token reports: per session its highest report, since each
 * harness reports a cumulative count, then per pool and for the Run, as the
 * runaway guard meters an Attempt. `reports` are each session's highest
 * `SessionTokensUpdated` rows, in Attempt order.
 */
const runUsage = (reports: ReadonlyArray<TranscriptEntry>): RunUsageView => {
  const highest = new Map<string, SessionUsageView>();
  for (const { attemptId, envelope } of reports) {
    const payload = envelope.payload;
    if (payload._tag !== "SessionEvent" || payload.event._tag !== "SessionTokensUpdated") continue;
    const { session, totalTokens, costUsd } = payload.event;
    const key = `${attemptId} ${session.id}`;
    const previous = highest.get(key);
    if (previous !== undefined && previous.tokens >= totalTokens) continue;
    const pool = brainPool(session.brain);
    highest.set(
      key,
      new SessionUsageView({
        attemptId,
        session,
        pool,
        tokens: totalTokens,
        cost: priced(pool, costUsd),
      }),
    );
  }
  const sessions = [...highest.values()];
  const pools = POOLS.flatMap((pool) => {
    const members = sessions.filter((session) => session.pool === pool);
    if (members.length === 0) return [];
    const costs = members.flatMap(({ cost }) => (cost === null ? [] : [cost.usd]));
    return [
      new PoolUsageView({
        pool,
        tokens: TokenCount.make(members.reduce((sum, { tokens }) => sum + tokens, 0)),
        cost: priced(
          pool,
          costs.length === members.length
            ? Option.some(UsdAmount.make(costs.reduce((sum, usd) => sum + usd, 0)))
            : Option.none(),
        ),
      }),
    ];
  });
  return new RunUsageView({
    tokens: TokenCount.make(sessions.reduce((sum, { tokens }) => sum + tokens, 0)),
    pools,
    sessions,
  });
};

const makeRunUsageReader = Effect.gen(function* () {
  const runs = yield* RunReader;
  const ended = yield* Effect.sync(() => new Map<AttemptId, ReadonlyArray<TranscriptEntry>>());

  const attemptReports = Effect.fn("RunUsageReader.attemptReports")(function* (attempt: Attempt) {
    const cached = ended.get(attempt.id);
    if (cached !== undefined) return { reports: cached, read: false };
    const reports = yield* runs.transcript(new TranscriptUsageQuery({ attemptId: attempt.id }));
    if (Option.isSome(attempt.outcome)) ended.set(attempt.id, reports);
    return { reports, read: true };
  });

  const read = Effect.fn("RunUsageReader.read")(function* (snapshot: RunSnapshot) {
    yield* Effect.annotateCurrentSpan({ runId: snapshot.run.id });
    const attempts = yield* Effect.forEach(snapshot.attempts, attemptReports, { concurrency: 4 });
    const usage = runUsage(attempts.flatMap(({ reports }) => reports));
    yield* Effect.logDebug("Read Run usage", {
      runId: snapshot.run.id,
      sessions: usage.sessions.length,
      tokens: usage.tokens,
      attemptsRead: attempts.filter(({ read: queried }) => queried).length,
      attemptsCached: attempts.filter(({ read: queried }) => !queried).length,
    });
    return usage;
  });

  return { read };
});

/**
 * Reads a Run's usage: every Attempt's highest token report per session, summed for the Run.
 * An Attempt with an outcome gets no more reports, so its reports are read once and kept for
 * the life of the process; an Attempt in flight is read on every call.
 */
export class RunUsageReader extends Context.Service<
  RunUsageReader,
  { readonly read: (snapshot: RunSnapshot) => Effect.Effect<RunUsageView, RunStoreError> }
>()("@usine/orchestrator/RunUsageReader") {
  static readonly layer = Layer.effect(RunUsageReader, makeRunUsageReader);
}
