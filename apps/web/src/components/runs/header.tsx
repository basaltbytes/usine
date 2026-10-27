import {
  ArrowsClockwiseIcon,
  CoinsIcon,
  HardDrivesIcon,
  RobotIcon,
  TimerIcon,
} from "@phosphor-icons/react";
import type {
  FactoryOverview,
  RunDetailView,
  RunDurationView,
  RunView,
} from "@usine/orchestrator/operator";
import { Option } from "effect";
import type { ComponentProps, ReactNode } from "react";
import { ItemHeading } from "~/components/item/heading";
import { taskCard } from "~/components/item/identity";
import { PullRequestMarks } from "~/components/item/pull-request-marks";
import { PageFact, PageHeader } from "~/components/page";
import { StateMark } from "~/components/status-badge";
import { useNow } from "~/hooks/use-now";
import { durationLabel } from "~/lib/strings";
import { providerLabel, providerMachineNoun } from "~/lib/workers/strings";
import { runStateLine } from "~/lib/runs/strings";
import { type RunItem, runHeaderItems, runItem } from "~/lib/runs/item";
import { UsageFact } from "~/components/runs/usage";

/** Returns the Item's title, or the Loop and repository if the Run has no Item or its title is unknown. */
const runTitleText = (run: Pick<RunView, "loop" | "repository">, item: Option.Option<RunItem>) =>
  Option.getOrElse(
    Option.flatMap(item, ({ title }) => title),
    () => `${run.loop} on ${run.repository}`,
  );

type LiveDurationProps = { readonly endedMillis: number; readonly since: string };

const LiveDuration = ({ endedMillis, since }: LiveDurationProps) => {
  const now = useNow(1_000);
  return <>{durationLabel(endedMillis + Math.max(0, now - Date.parse(since)))}</>;
};

type DurationProps = { readonly duration: RunDurationView };

/** Renders the total Attempt time, which keeps counting while an Attempt runs. */
const Duration = ({ duration }: DurationProps) => (
  <span
    title={
      duration.unmeasured === 0
        ? "Total attempt time"
        : `${duration.unmeasured} ${duration.unmeasured === 1 ? "attempt" : "attempts"} not counted: no recorded end time`
    }
    className="font-mono text-xs tabular-nums"
  >
    {duration.unmeasured > 0 && "at least "}
    {duration.runningSince === null ? (
      durationLabel(duration.endedMillis)
    ) : (
      <LiveDuration endedMillis={duration.endedMillis} since={duration.runningSince} />
    )}
  </span>
);

type AttemptMachineProps = { readonly detail: RunDetailView };

/** Renders the provider ID of the machine that the newest Attempt runs on, if it has one. */
const AttemptMachine = ({ detail }: AttemptMachineProps) => {
  const { machine, run } = detail;
  if (machine === null || machine.state !== "ready" || machine.id === null) return null;
  if (machine.attemptId === null || machine.attemptId !== run.attempts.at(-1)?.id) return null;
  return (
    <span
      className="font-mono text-xs"
      title={`${providerLabel[machine.provider]} ${providerMachineNoun[machine.provider]} ${machine.id}`}
    >
      {machine.id}
    </span>
  );
};

type RunHeaderProps = {
  readonly detail: RunDetailView;
  readonly overview: FactoryOverview | undefined;
  /** `page` shows tokens and puts the actions beside the heading from `lg`; `drawer` puts them under it. */
  readonly placement: "page" | "drawer";
  /** Whether the title and state get the drawer-to-page view transition names; only one visible header can have them. */
  readonly shared: boolean;
  readonly actions: ReactNode;
  /** The heading element, such as the drawer's dialog title; `h1` by default. */
  readonly as?: ComponentProps<typeof ItemHeading>["as"];
  readonly className?: string;
};

/**
 * Renders a Run's header: the Loop and Agent, the Task's name, then the state, the Run's pull
 * request, and once an Attempt has started, the duration, tokens on the page, and Worker.
 */
export const RunHeader = ({
  detail,
  overview,
  placement,
  shared,
  actions,
  as,
  className,
}: RunHeaderProps) => {
  const { run } = detail;
  const item = runItem(run, overview, detail.eventPayload);
  const items = runHeaderItems(run, item, taskCard(overview, run.itemKey), detail.settledItemState);
  return (
    <PageHeader
      actionsBeside={placement === "page" ? "lg" : "never"}
      {...(className === undefined ? {} : { className })}
      eyebrow={
        <>
          <PageFact icon={ArrowsClockwiseIcon} title="Loop">
            {run.loop}
          </PageFact>
          <PageFact icon={RobotIcon} title="Agent">
            {run.agent}
          </PageFact>
        </>
      }
      heading={
        <ItemHeading
          variant="page"
          item={items.heading}
          title={Option.getOrElse(items.title, () => runTitleText(run, item))}
          {...(as === undefined ? {} : { as })}
          {...(shared ? { style: { viewTransitionName: "run-title" } } : {})}
        />
      }
      facts={
        <>
          <span
            className="inline-flex items-center gap-2 font-medium text-foreground"
            style={shared ? { viewTransitionName: "run-state" } : undefined}
          >
            <StateMark state={run.state} />
            {runStateLine(run, detail.unconfirmedStop, detail.machine)}
          </span>
          <PullRequestMarks pullRequests={Option.toArray(items.pullRequest)} />
          {detail.worker !== null && (
            <>
              <PageFact icon={TimerIcon}>
                <Duration duration={detail.duration} />
              </PageFact>
              {placement === "page" && detail.usage.sessions.length > 0 && (
                <PageFact icon={CoinsIcon}>
                  <UsageFact usage={detail.usage} attempts={run.attempts} />
                </PageFact>
              )}
              <PageFact icon={HardDrivesIcon} title="Worker">
                {detail.worker}
                <AttemptMachine detail={detail} />
              </PageFact>
            </>
          )}
          {run.loopPaused && <span>Loop paused</span>}
        </>
      }
      actions={actions}
    />
  );
};
