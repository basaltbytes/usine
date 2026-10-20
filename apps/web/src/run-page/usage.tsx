import type {
  AttemptView,
  RunUsageView,
  SessionUsageView,
  UsageCostView,
} from "@usine/orchestrator/operator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { poolLabel, tokensLabel, usdLabel } from "../operator-copy.ts";

const count = new Intl.NumberFormat("en");

/** A price as the operator reads it: dollars, and the word estimate on the Claude plan's figure. */
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

/**
 * What the Run's Attempts used: tokens per billing pool with its price where
 * the pool has a dollar rate, then per session under each Attempt. The
 * ChatGPT plan says it has no dollar rate instead of showing a price.
 */
export const UsageBreakdown = ({
  usage,
  attempts,
}: {
  readonly usage: RunUsageView;
  readonly attempts: ReadonlyArray<Pick<AttemptView, "id" | "number">>;
}) => (
  <>
    <section aria-label="Tokens per pool">
      <h2 className="pb-1 text-sm font-medium text-foreground">Tokens per pool</h2>
      {usage.pools.map((pool) => (
        <div key={pool.pool} className={row}>
          <span className="truncate text-foreground">{poolLabel(pool.pool)}</span>
          <span className="text-right font-mono text-foreground tabular-nums">
            {count.format(pool.tokens)}
          </span>
          <span className="text-right">
            {pool.pool === "chatgptPlan" ? (
              <span className="text-muted-foreground">No dollar rate</span>
            ) : (
              <Cost cost={pool.cost} />
            )}
          </span>
        </div>
      ))}
    </section>
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
      Tokens are output and uncached input. Dollars are each harness's own price.
    </p>
  </>
);

/** The Run header's token total, opening to the breakdown per pool and session. */
export const UsageFact = ({
  usage,
  attempts,
}: {
  readonly usage: RunUsageView;
  readonly attempts: ReadonlyArray<Pick<AttemptView, "id" | "number">>;
}) => (
  <span className="inline-flex items-baseline gap-1.5">
    Tokens
    <Popover>
      <PopoverTrigger
        aria-label={`Tokens: ${count.format(usage.tokens)}. Show them per pool and session`}
        className="rounded-sm font-mono text-xs text-primary tabular-nums underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        {tokensLabel(usage.tokens)}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[26rem] max-w-[calc(100vw-2rem)] gap-3 p-3 text-xs shadow-raised"
      >
        <UsageBreakdown usage={usage} attempts={attempts} />
      </PopoverContent>
    </Popover>
  </span>
);
