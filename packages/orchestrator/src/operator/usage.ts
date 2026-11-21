import { catalog } from "@usine/agents/harness";
import { BillingPool, BillingPools, type PoolDescriptor } from "@usine/core/agent/pool";
import {
  AgentSession,
  sessionPool,
  type SessionTokensUpdated,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import type { RunStoreError } from "@usine/engine/engine";
import type { RunId } from "@usine/core/run";
import {
  RunReader,
  type RunSummary,
  type ItemRunHistory,
  RunUsageSource,
} from "@usine/engine/run-reader";
import { type TranscriptEntry, TranscriptUsageQuery } from "@usine/engine/transcript";
import { Array as Arr, type Brand, Context, Effect, Layer, Option, Order, Schema } from "effect";
import type { AttemptView } from "./attempt.ts";

/**
 * A dollar cost from a harness or from usine's OpenAI price table. `estimate` is true in a plan
 * pool, which doesn't bill per token (ADR 0013).
 */
export class UsageCostView extends Schema.Class<
  UsageCostView,
  Brand.Brand<"@usine/orchestrator/operator/usage/UsageCostView">
>("@usine/orchestrator/UsageCostView")({
  /** The priced usage in US dollars. */
  usd: UsdAmount,
  /**
   * Whether the amount estimates usage on a subscription plan rather than per-token billing (ADR
   * 0013).
   */
  estimate: Schema.Boolean,
}) {}

/** One Attempt session's usage from its highest token report, and its billing pool. */
export class SessionUsageView extends Schema.Class<
  SessionUsageView,
  Brand.Brand<"@usine/orchestrator/operator/usage/SessionUsageView">
>("@usine/orchestrator/SessionUsageView")({
  /** The attempt associated with this entry. */
  attemptId: AttemptId,
  /** The parent or child session whose highest token report supplies this usage. */
  session: AgentSession,
  /** The billing source for this usage. */
  pool: BillingPool,
  /** The total reported tokens, summed once per session. */
  tokens: TokenCount,
  /** Null if neither the harness nor the OpenAI price table priced the session. */
  cost: Schema.NullOr(UsageCostView),
}) {}

/** A Run's usage in one billing pool. */
export class PoolUsageView extends Schema.Class<
  PoolUsageView,
  Brand.Brand<"@usine/orchestrator/operator/usage/PoolUsageView">
>("@usine/orchestrator/PoolUsageView")({
  /** The billing source for this usage. */
  pool: BillingPool,
  /** The pool's catalog label, or its ID for a pool that the catalog doesn't declare. */
  label: Schema.NonEmptyString,
  /** The total reported tokens, summed once per session. */
  tokens: TokenCount,
  /** Null if any session in the pool has no price. */
  cost: Schema.NullOr(UsageCostView),
}) {}

/** The tokens a Run's Attempts used, per pool and session, with their prices. */
export class RunUsageView extends Schema.Class<
  RunUsageView,
  Brand.Brand<"@usine/orchestrator/operator/usage/RunUsageView">
>("@usine/orchestrator/RunUsageView")({
  /** The total reported tokens, summed once per session. */
  tokens: TokenCount,
  /** In catalog order, then undeclared pools by ID; unused pools are absent. */
  pools: Schema.Array(PoolUsageView),
  /** In order of Attempt start, then first report. */
  sessions: Schema.Array(SessionUsageView),
}) {}

/** A Task's usage in one billing pool, summed over every session of every Run. */
export class TaskPoolUsageView extends Schema.Class<
  TaskPoolUsageView,
  Brand.Brand<"@usine/orchestrator/operator/usage/TaskPoolUsageView">
>("@usine/orchestrator/TaskPoolUsageView")({
  /** The billing source for this usage. */
  pool: BillingPool,
  /** The pool's catalog label, or its ID for a pool that the catalog doesn't declare. */
  label: Schema.NonEmptyString,
  /** The total reported tokens, summed once per session. */
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
export class TaskUsageView extends Schema.Class<
  TaskUsageView,
  Brand.Brand<"@usine/orchestrator/operator/usage/TaskUsageView">
>("@usine/orchestrator/TaskUsageView")({
  /** The summed wall time of ended Attempts, each from start to recorded end. */
  durationMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The start times of running Attempts; add the time since each to `durationMillis`. */
  runningSince: Schema.Array(Schema.String),
  /** The number of ended Attempts with no recorded end, excluded from `durationMillis`. */
  unmeasured: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The total reported tokens, summed once per session. */
  tokens: TokenCount,
  /**
   * Each pool summed over the Runs, in catalog order, then undeclared pools by ID; unused pools
   * are absent.
   */
  pools: Schema.Array(TaskPoolUsageView),
  /**
   * The summed cost of the priced pools, or null if no pool has a price. It's an estimate if it
   * includes a plan pool, and a lower bound if a pool is `unpriced`.
   */
  cost: Schema.NullOr(UsageCostView),
}) {}

/** The members of one billing pool, with how the catalog presents and bills that pool. */
interface PoolGroup<A> {
  readonly pool: BillingPool;
  readonly label: string;
  /** Whether the pool is a plan, whose prices estimate rather than bill usage (ADR 0013). */
  readonly plan: boolean;
  readonly members: Arr.NonEmptyReadonlyArray<A>;
}

/**
 * Groups `members` by billing pool: the pools that `pools` declares in its order, then the
 * undeclared pools, such as those of a removed harness, by ID. An undeclared pool shows under its
 * ID and isn't a plan.
 */
export const poolGroups = <A extends { readonly pool: BillingPool }>(
  pools: ReadonlyArray<PoolDescriptor>,
  members: ReadonlyArray<A>,
): ReadonlyArray<PoolGroup<A>> => {
  const position = (pool: BillingPool) => {
    const index = pools.findIndex(({ id }) => id === pool);
    return index === -1 ? pools.length : index;
  };
  const order = Order.combine(
    Order.mapInput(Order.Number, ({ pool }: PoolGroup<A>) => position(pool)),
    Order.mapInput(Order.String, ({ pool }: PoolGroup<A>) => pool),
  );
  return Arr.sort(
    Object.values(Arr.groupBy(members, ({ pool }) => pool)).map((group) => {
      const pool = group[0].pool;
      const declared = pools.find(({ id }) => id === pool);
      return {
        pool,
        label: declared?.label ?? pool,
        plan: declared?.billing === "plan",
        members: group,
      };
    }),
    order,
  );
};

/** Whether `pools` declares `pool` as a plan. */
const isPlan = (pools: ReadonlyArray<PoolDescriptor>, pool: BillingPool): boolean =>
  pools.some(({ id, billing }) => id === pool && billing === "plan");

const priced = (plan: boolean, usd: Option.Option<UsdAmount>): UsageCostView | null =>
  Option.match(usd, {
    onNone: () => null,
    onSome: (value) => UsageCostView.make({ usd: value, estimate: plan }),
  });

/** Returns the harness's price, or for a Codex session, the OpenAI table's price of its breakdown. */
const sessionPrice = ({
  session,
  costUsd,
  breakdown,
}: SessionTokensUpdated): Option.Option<UsdAmount> =>
  Option.orElse(costUsd, () =>
    Option.flatMap(catalog.get(session.brain.harness), (descriptor) =>
      Option.flatMap(breakdown, (tokens) => descriptor.price(session.brain.model, tokens)),
    ),
  );

interface RunUsage {
  readonly view: RunUsageView;
  /** The models of Codex sessions with a token breakdown that the OpenAI price table lacks. */
  readonly unknownModels: ReadonlySet<string>;
}

/**
 * Sums a Run's token reports per pool of `pools` and for the Run, using each session's highest
 * report because reports are cumulative.
 */
const runUsage = (
  pools: ReadonlyArray<PoolDescriptor>,
  reports: ReadonlyArray<TranscriptEntry>,
): RunUsage => {
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
    return SessionUsageView.make({
      attemptId,
      session: report.session,
      pool,
      tokens: report.totalTokens,
      cost: priced(isPlan(pools, pool), price),
    });
  });
  const unknownModels = new Set(
    latest.flatMap(({ report, price }) =>
      Option.isNone(price) &&
      Option.exists(catalog.get(report.session.brain.harness), (descriptor) =>
        Option.isSome(descriptor.prices),
      ) &&
      Option.isSome(report.breakdown)
        ? [report.session.brain.model]
        : [],
    ),
  );
  const poolUsage = poolGroups(pools, sessions).map(({ pool, label, plan, members }) => {
    const costs = members.flatMap(({ cost }) => (cost === null ? [] : [cost.usd]));
    return PoolUsageView.make({
      pool,
      label,
      tokens: TokenCount.make(members.reduce((sum, { tokens }) => sum + tokens, 0)),
      cost: priced(
        plan,
        costs.length === members.length
          ? Option.some(UsdAmount.make(costs.reduce((sum, usd) => sum + usd, 0)))
          : Option.none(),
      ),
    });
  });
  return {
    view: RunUsageView.make({
      tokens: TokenCount.make(sessions.reduce((sum, { tokens }) => sum + tokens, 0)),
      pools: poolUsage,
      sessions,
    }),
    unknownModels,
  };
};

/**
 * Sums the Attempt time, tokens, and cost of a Task's `runs` per pool of `pools`. Pools sum sessions
 * rather than Run pools, so priced sessions count even when another session is unpriced, which
 * sets `unpriced`.
 */
export const taskUsage = (
  pools: ReadonlyArray<PoolDescriptor>,
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
  return taskUsageTotals(
    pools,
    runs.map(({ id }) => id),
    { durationMillis, unmeasured, runningSince },
    usage,
  );
};

const taskUsageTotals = (
  pools: ReadonlyArray<PoolDescriptor>,
  runIds: ReadonlyArray<RunId>,
  timing: Pick<TaskUsageView, "durationMillis" | "unmeasured" | "runningSince">,
  usage: ReadonlyMap<RunId, RunUsageView>,
): TaskUsageView => {
  const sessions = runIds.flatMap((id) => usage.get(id)?.sessions ?? []);
  const poolUsage = poolGroups(pools, sessions).map(({ pool, label, plan, members }) => {
    const costs = members.flatMap(({ cost }) => (cost === null ? [] : [cost.usd]));
    return TaskPoolUsageView.make({
      pool,
      label,
      tokens: TokenCount.make(members.reduce((sum, { tokens }) => sum + tokens, 0)),
      cost: priced(
        plan,
        costs.length === 0
          ? Option.none()
          : Option.some(UsdAmount.make(costs.reduce((sum, usd) => sum + usd, 0))),
      ),
      unpriced: costs.length < members.length,
    });
  });
  const costs = poolUsage.flatMap(({ cost }) => (cost === null ? [] : [cost]));
  return TaskUsageView.make({
    ...timing,
    durationMillis: Math.round(timing.durationMillis),
    tokens: TokenCount.make(sessions.reduce((sum, { tokens }) => sum + tokens, 0)),
    pools: poolUsage,
    cost:
      costs.length === 0
        ? null
        : UsageCostView.make({
            usd: UsdAmount.make(costs.reduce((sum, { usd }) => sum + usd, 0)),
            estimate: costs.some(({ estimate }) => estimate),
          }),
  });
};

/** Combines SQL history totals with session usage per pool of `pools` for the task's items. */
export const taskHistoryUsage = (
  pools: ReadonlyArray<PoolDescriptor>,
  items: ReadonlyArray<ItemRunHistory>,
  usage: ReadonlyMap<RunId, RunUsageView>,
): TaskUsageView =>
  taskUsageTotals(
    pools,
    items.flatMap(({ usageSources }) => usageSources.map(({ run }) => run.id)),
    {
      durationMillis: items.reduce((sum, item) => sum + item.durationMillis, 0),
      unmeasured: items.reduce((sum, item) => sum + item.unmeasured, 0),
      runningSince: items.flatMap(({ runningSince }) => runningSince),
    },
    usage,
  );

/** Selects the attempt identities and terminal status needed for token reports. */
export const runUsageSource = (source: {
  readonly run: Pick<RunSummary["run"], "id">;
  readonly attempts: ReadonlyArray<Pick<RunSummary["attempts"][number], "id" | "outcome">>;
}): RunUsageSource =>
  RunUsageSource.make({
    run: { id: source.run.id },
    attempts: source.attempts.map(({ id, outcome }) => ({ id, ended: Option.isSome(outcome) })),
  });

const makeRunUsageReader = Effect.gen(function* () {
  const runs = yield* RunReader;
  const ended = yield* Effect.sync(() => new Map<AttemptId, ReadonlyArray<TranscriptEntry>>());
  const loggedModels = yield* Effect.sync(() => new Set<string>());

  const attemptReports = Effect.fn("RunUsageReader.attemptReports")(function* (
    attempt: RunUsageSource["attempts"][number],
  ) {
    const cached = ended.get(attempt.id);
    if (cached !== undefined) return { reports: cached, read: false };
    const reports = yield* runs.transcript(TranscriptUsageQuery.make({ attemptId: attempt.id }));
    if (attempt.ended) ended.set(attempt.id, reports);
    return { reports, read: true };
  });

  const read = Effect.fn("RunUsageReader.read")(function* (snapshot: RunUsageSource) {
    yield* Effect.annotateCurrentSpan({ runId: snapshot.run.id });
    const attempts = yield* Effect.forEach(snapshot.attempts, attemptReports, { concurrency: 4 });
    const pools = yield* BillingPools;
    const { view: usage, unknownModels } = runUsage(
      pools,
      attempts.flatMap(({ reports }) => reports),
    );
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

/**
 * Reads a Run's usage from each session's highest token report. Caches the reports of Attempts with
 * an outcome and rereads running Attempts on every call. Logs one warning per Codex model that the
 * OpenAI price table lacks.
 */
export class RunUsageReader extends Context.Service<
  RunUsageReader,
  { readonly read: (run: RunUsageSource) => Effect.Effect<RunUsageView, RunStoreError> }
>()("@usine/orchestrator/operator/usage/RunUsageReader") {
  static readonly layer = Layer.effect(RunUsageReader, makeRunUsageReader);
}
