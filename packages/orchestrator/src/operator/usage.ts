import { openAiPrice } from "@usine/agents/openai-prices";
import {
  AgentSession,
  BillingPool,
  sessionPool,
  type SessionTokensUpdated,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import { type Attempt, AttemptId } from "@usine/core/attempt";
import type { RunStoreError } from "@usine/engine/engine";
import type { RunId } from "@usine/core/run";
import { RunReader, type RunSnapshot } from "@usine/engine/run-reader";
import { type TranscriptEntry, TranscriptUsageQuery } from "@usine/engine/transcript";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { AttemptView } from "./attempt.ts";

/**
 * A dollar cost from a harness or from usine's OpenAI price table. `estimate` is true in the Claude
 * and ChatGPT plans, which don't bill per token (ADR 0013).
 */
export class UsageCostView extends Schema.Class<UsageCostView>("@usine/orchestrator/UsageCostView")(
  { usd: UsdAmount, estimate: Schema.Boolean },
) {}

/** One Attempt session's usage from its highest token report, and its billing pool. */
export class SessionUsageView extends Schema.Class<SessionUsageView>(
  "@usine/orchestrator/SessionUsageView",
)({
  attemptId: AttemptId,
  session: AgentSession,
  pool: BillingPool,
  tokens: TokenCount,
  /** Null if neither the harness nor the OpenAI price table priced the session. */
  cost: Schema.NullOr(UsageCostView),
}) {}

/** A Run's usage in one billing pool. */
export class PoolUsageView extends Schema.Class<PoolUsageView>("@usine/orchestrator/PoolUsageView")(
  {
    pool: BillingPool,
    tokens: TokenCount,
    /** Null if any session in the pool has no price. */
    cost: Schema.NullOr(UsageCostView),
  },
) {}

/** The tokens a Run's Attempts used, per pool and session, with their prices. */
export class RunUsageView extends Schema.Class<RunUsageView>("@usine/orchestrator/RunUsageView")({
  tokens: TokenCount,
  /** In the order API keys, Claude plan, ChatGPT plan; unused pools are absent. */
  pools: Schema.Array(PoolUsageView),
  /** In order of Attempt start, then first report. */
  sessions: Schema.Array(SessionUsageView),
}) {}

/** A Task's usage in one billing pool, summed over every session of every Run. */
export class TaskPoolUsageView extends Schema.Class<TaskPoolUsageView>(
  "@usine/orchestrator/TaskPoolUsageView",
)({
  pool: BillingPool,
  tokens: TokenCount,
  /** The cost of the priced sessions, or null if no session in the pool has a price yet. */
  cost: Schema.NullOr(UsageCostView),
  /** Whether a session in the pool has no price yet, so `cost` is a lower bound. */
  unpriced: Schema.Boolean,
}) {}

/**
 * A Task's usage over every Run on its Items: Attempt wall time, and tokens and cost per billing
 * pool.
 */
export class TaskUsageView extends Schema.Class<TaskUsageView>("@usine/orchestrator/TaskUsageView")(
  {
    /** The summed wall time of ended Attempts, each from start to recorded end. */
    durationMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    /** The start times of running Attempts; add the time since each to `durationMillis`. */
    runningSince: Schema.Array(Schema.String),
    /** The number of ended Attempts with no recorded end, excluded from `durationMillis`. */
    unmeasured: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    tokens: TokenCount,
    /**
     * Each pool summed over the Runs, in the order API keys, Claude plan, ChatGPT plan; unused
     * pools are absent.
     */
    pools: Schema.Array(TaskPoolUsageView),
    /**
     * The summed cost of the priced pools, or null if no pool has a price. It's an estimate if it
     * includes the Claude or ChatGPT plan, and a lower bound if a pool is `unpriced`.
     */
    cost: Schema.NullOr(UsageCostView),
  },
) {}

const POOLS: ReadonlyArray<BillingPool> = ["apiKeys", "claudePlan", "chatgptPlan"];

const priced = (pool: BillingPool, usd: Option.Option<UsdAmount>): UsageCostView | null =>
  Option.match(usd, {
    onNone: () => null,
    onSome: (value) => new UsageCostView({ usd: value, estimate: pool !== "apiKeys" }),
  });

/** Returns the harness's price, or for a Codex session, the OpenAI table's price of its breakdown. */
const sessionPrice = ({
  session,
  costUsd,
  breakdown,
}: SessionTokensUpdated): Option.Option<UsdAmount> =>
  Option.isSome(costUsd) || session.brain.harness !== "codex"
    ? costUsd
    : Option.flatMap(breakdown, (tokens) => openAiPrice(session.brain.model, tokens));

interface RunUsage {
  readonly view: RunUsageView;
  /** The models of Codex sessions with a token breakdown that the OpenAI price table lacks. */
  readonly unknownModels: ReadonlySet<string>;
}

/**
 * Sums a Run's token reports per pool and for the Run, using each session's highest report because
 * reports are cumulative.
 */
const runUsage = (reports: ReadonlyArray<TranscriptEntry>): RunUsage => {
  const highest = new Map<string, { attemptId: AttemptId; report: SessionTokensUpdated }>();
  for (const { attemptId, envelope } of reports) {
    const payload = envelope.payload;
    if (payload._tag !== "SessionEvent" || payload.event._tag !== "SessionTokensUpdated") continue;
    const key = `${attemptId} ${payload.event.session.id}`;
    const previous = highest.get(key);
    if (previous !== undefined && previous.report.totalTokens >= payload.event.totalTokens)
      continue;
    highest.set(key, { attemptId, report: payload.event });
  }
  const latest = [...highest.values()].map((entry) => ({
    ...entry,
    price: sessionPrice(entry.report),
  }));
  const sessions = latest.map(({ attemptId, report, price }) => {
    const pool = sessionPool(report.session);
    return new SessionUsageView({
      attemptId,
      session: report.session,
      pool,
      tokens: report.totalTokens,
      cost: priced(pool, price),
    });
  });
  const unknownModels = new Set(
    latest.flatMap(({ report, price }) =>
      Option.isNone(price) &&
      report.session.brain.harness === "codex" &&
      Option.isSome(report.breakdown)
        ? [report.session.brain.model]
        : [],
    ),
  );
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
  return {
    view: new RunUsageView({
      tokens: TokenCount.make(sessions.reduce((sum, { tokens }) => sum + tokens, 0)),
      pools,
      sessions,
    }),
    unknownModels,
  };
};

/**
 * Sums the Attempt time, tokens, and cost of a Task's `runs`. Pools sum sessions rather than Run
 * pools, so priced sessions count even when another session is unpriced, which sets `unpriced`.
 */
export const taskUsage = (
  runs: ReadonlyArray<{
    readonly id: RunId;
    readonly attempts: ReadonlyArray<Pick<AttemptView, "startedAt" | "endedAt" | "outcome">>;
  }>,
  usage: ReadonlyMap<RunId, RunUsageView>,
): TaskUsageView => {
  let durationMillis = 0;
  let unmeasured = 0;
  const runningSince: Array<string> = [];
  for (const { attempts } of runs) {
    for (const { startedAt, endedAt, outcome } of attempts) {
      if (outcome === null) runningSince.push(startedAt);
      else if (endedAt === null) unmeasured += 1;
      else durationMillis += Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    }
  }
  const sessions = runs.flatMap(({ id }) => usage.get(id)?.sessions ?? []);
  const pools = POOLS.flatMap((pool) => {
    const members = sessions.filter((session) => session.pool === pool);
    if (members.length === 0) return [];
    const costs = members.flatMap(({ cost }) => (cost === null ? [] : [cost.usd]));
    return [
      new TaskPoolUsageView({
        pool,
        tokens: TokenCount.make(members.reduce((sum, { tokens }) => sum + tokens, 0)),
        cost: priced(
          pool,
          costs.length === 0
            ? Option.none()
            : Option.some(UsdAmount.make(costs.reduce((sum, usd) => sum + usd, 0))),
        ),
        unpriced: costs.length < members.length,
      }),
    ];
  });
  const costs = pools.flatMap(({ cost }) => (cost === null ? [] : [cost]));
  return new TaskUsageView({
    durationMillis: Math.round(durationMillis),
    runningSince,
    unmeasured,
    tokens: TokenCount.make(sessions.reduce((sum, { tokens }) => sum + tokens, 0)),
    pools,
    cost:
      costs.length === 0
        ? null
        : new UsageCostView({
            usd: UsdAmount.make(costs.reduce((sum, { usd }) => sum + usd, 0)),
            estimate: costs.some(({ estimate }) => estimate),
          }),
  });
};

const makeRunUsageReader = Effect.gen(function* () {
  const runs = yield* RunReader;
  const ended = yield* Effect.sync(() => new Map<AttemptId, ReadonlyArray<TranscriptEntry>>());
  const loggedModels = yield* Effect.sync(() => new Set<string>());

  const attemptReports = Effect.fn("RunUsageReader.attemptReports")(function* (attempt: Attempt) {
    const cached = ended.get(attempt.id);
    if (cached !== undefined) return { reports: cached, read: false };
    const reports = yield* runs.transcript(new TranscriptUsageQuery({ attemptId: attempt.id }));
    if (Option.isSome(attempt.outcome)) ended.set(attempt.id, reports);
    return { reports, read: true };
  });

  const read = Effect.fn("RunUsageReader.read")(function* (snapshot: RunUsageSource) {
    yield* Effect.annotateCurrentSpan({ runId: snapshot.run.id });
    const attempts = yield* Effect.forEach(snapshot.attempts, attemptReports, { concurrency: 4 });
    const { view: usage, unknownModels } = runUsage(attempts.flatMap(({ reports }) => reports));
    for (const model of unknownModels) {
      if (loggedModels.has(model)) continue;
      loggedModels.add(model);
      yield* Effect.logWarning(
        "The OpenAI price table has no rates for a Codex model, so its sessions have no cost",
        { model, runId: snapshot.run.id },
      );
    }
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

type RunUsageSource = Pick<RunSnapshot, "run" | "attempts">;

/**
 * Reads a Run's usage from each session's highest token report. Caches the reports of Attempts with
 * an outcome and rereads running Attempts on every call. Logs one warning per Codex model that the
 * OpenAI price table lacks.
 */
export class RunUsageReader extends Context.Service<
  RunUsageReader,
  { readonly read: (run: RunUsageSource) => Effect.Effect<RunUsageView, RunStoreError> }
>()("@usine/orchestrator/RunUsageReader") {
  static readonly layer = Layer.effect(RunUsageReader, makeRunUsageReader);
}
