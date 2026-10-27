import type {
  AttemptView,
  PoolUsageView,
  RunUsageView,
  SessionUsageView,
  TaskPoolUsageView,
  UsageCostView,
} from "@usine/orchestrator/operator";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { poolLabel, tokensLabel, usdLabel } from "~/lib/strings";

const count = new Intl.NumberFormat("en");

/** Renders the cost in dollars, followed by `estimate` if the cost is an estimate. */
const Cost = ({ cost }: { readonly cost: UsageCostView | null }) =>
  cost === null ? null : (
    <>
      <span className="font-mono text-foreground tabular-nums">{usdLabel(cost.usd)}</span>
      {cost.estimate && <span className="text-muted-foreground"> estimate</span>}
    </>
  );

const sessionName = ({ session }: SessionUsageView) =>
  session._tag === "ParentSession" ? "Parent" : session.agent;

const row = "grid grid-cols-[minmax(0,1fr)_auto_7rem] items-baseline gap-x-3 py-0.5";
// The wider price column fits `at least`; every row uses it so the token figures stay aligned.
const lowerBoundRow = "grid grid-cols-[minmax(0,1fr)_auto_10rem] items-baseline gap-x-3 py-0.5";

/** A pool line from a Run or a Task; on a Task, `unpriced` marks the price as a lower bound. */
type PoolLine = PoolUsageView | TaskPoolUsageView;

const unpriced = (pool: PoolLine): boolean => "unpriced" in pool && pool.unpriced;

/**
 * Renders tokens per billing pool, with a price if the pool has one. A Task pool with unpriced
 * usage shows its price as `at least`.
 */
export const PoolBreakdown = ({ pools }: { readonly pools: ReadonlyArray<PoolLine> }) => {
  const lowerBound = pools.some((pool) => unpriced(pool) && pool.cost !== null);
  return (
    <section aria-label="Tokens per pool">
      <h2 className="pb-1 text-sm font-medium text-foreground">Tokens per pool</h2>
      {pools.map((pool) => (
        <div key={pool.pool} className={lowerBound ? lowerBoundRow : row}>
          <span className="truncate text-foreground">{poolLabel(pool.pool)}</span>
          <span className="text-right font-mono text-foreground tabular-nums">
            {count.format(pool.tokens)}
          </span>
          <span className="text-right">
            {unpriced(pool) && pool.cost !== null && (
              <span className="text-muted-foreground">at least </span>
            )}
            <Cost cost={pool.cost} />
          </span>
        </div>
      ))}
    </section>
  );
};

/** Renders usage per billing pool, then per session under each Attempt. */
export const UsageBreakdown = ({
  usage,
  attempts,
}: {
  readonly usage: RunUsageView;
  readonly attempts: ReadonlyArray<Pick<AttemptView, "id" | "number">>;
}) => (
  <>
    <PoolBreakdown pools={usage.pools} />
    <section aria-label="Tokens per session" className="border-t pt-2.5">
      <h2 className="pb-1 text-sm font-medium text-foreground">Tokens per session</h2>
      {attempts.map((attempt) => {
        const sessions = usage.sessions.filter(({ attemptId }) => attemptId === attempt.id);
        return sessions.length === 0 ? null : (
          <div key={attempt.id} className="pb-1">
            <h3 className="pt-1 text-muted-foreground">Attempt {attempt.number}</h3>
            {sessions.map((session) => (
              <div key={session.session.id} className={row}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-foreground">{sessionName(session)}</span>
                  <span className="truncate font-mono text-muted-foreground">
                    {session.session.brain.model}
                  </span>
                </span>
                <span className="text-right font-mono text-foreground tabular-nums">
                  {count.format(session.tokens)}
                </span>
                <span className="text-right">
                  <Cost cost={session.cost} />
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </section>
    <p className="text-muted-foreground">
      Tokens are output and uncached input. Dollars are the price each harness reports, or for
      Codex, the OpenAI API price.
    </p>
  </>
);

/** Renders the token total, such as `27.3K tokens`, which opens the breakdown per pool and session. */
export const UsageFact = ({
  usage,
  attempts,
}: {
  readonly usage: RunUsageView;
  readonly attempts: ReadonlyArray<Pick<AttemptView, "id" | "number">>;
}) => (
  <Popover>
    <PopoverTrigger
      aria-label={`Tokens: ${count.format(usage.tokens)}. Show per pool and session`}
      className="rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70"
    >
      <span className="font-mono text-xs tabular-nums">{tokensLabel(usage.tokens)}</span> tokens
    </PopoverTrigger>
    <PopoverContent
      align="start"
      className="w-[26rem] max-w-[calc(100vw-2rem)] gap-3 p-3 text-xs shadow-raised"
    >
      <UsageBreakdown usage={usage} attempts={attempts} />
    </PopoverContent>
  </Popover>
);
