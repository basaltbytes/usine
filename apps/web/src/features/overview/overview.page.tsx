import { DismissedNeeds } from "~/features/overview/components/dismissed-needs";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { NeedView, RepositoryPollView } from "@usine/orchestrator/operator";
import { ErrorAlert } from "~/components/error-alert";
import { Page, PageHeading } from "~/components/page";
import {
  ReloadConfigurationButton,
  ReloadOutcome,
  useReloadConfiguration,
} from "~/components/configuration/reload";
import { Skeleton } from "~/components/ui/skeleton";
import { useNow } from "~/hooks/use-now";
import { NeedEntry } from "~/components/needs-you/needs-you";
import { overviewQuery } from "~/lib/overview";
import { deskCounts, lastCheckedLabel } from "~/features/overview/strings";
import { LastOutcomes } from "~/features/overview/components/last-outcomes";
import { NotMoving } from "~/features/overview/components/not-moving";
import { deskQuery } from "~/lib/desk/queries";
import { RunningNow } from "~/features/overview/components/running-now";
import { DeskSection, EmptyLine } from "~/components/overview/section";
import { Statistics } from "~/features/overview/components/statistics/statistics";
import { WorkersLine } from "~/features/overview/components/workers-line";

const NoProjects = () => {
  const reload = useReloadConfiguration();
  return (
    <section className="flex flex-col items-start gap-3">
      <div className="flex max-w-prose flex-col gap-1">
        <h2 className="text-md font-medium">No projects registered</h2>
        <p className="text-muted-foreground">
          Add each repository under <code>repos</code> in <code>usine.yaml</code>, then reload the
          configuration.
        </p>
      </div>
      <ReloadConfigurationButton reload={reload} />
      <ReloadOutcome reload={reload} />
    </section>
  );
};

type DeskNeedsYouProps = {
  readonly needs: ReadonlyArray<NeedView>;
  readonly dismissedNeeds?: ReadonlyArray<NeedView>;
  readonly polls: ReadonlyArray<RepositoryPollView>;
  readonly now: number;
};

export const DeskNeedsYou = ({ needs, dismissedNeeds = [], polls, now }: DeskNeedsYouProps) => (
  <DeskSection
    id="desk-needs-you"
    title="Needs attention"
    count={needs.length}
    countTone="needs-you"
    note={lastCheckedLabel(polls, now) ?? undefined}
  >
    {needs.length === 0 ? (
      <EmptyLine>Nothing needs attention</EmptyLine>
    ) : (
      <ul className="grid grid-cols-1 items-start gap-2.5 lg:grid-cols-2">
        {needs.map((need) => (
          <NeedEntry key={need.id} need={need} compact={false} />
        ))}
      </ul>
    )}
    <DismissedNeeds needs={dismissedNeeds} />
  </DeskSection>
);

type LoadingBlockProps = { readonly id: string; readonly title: string };

const LoadingBlock = ({ id, title }: LoadingBlockProps) => (
  <DeskSection id={id} title={title}>
    <div aria-hidden="true" className="flex flex-col border-t">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex h-11 items-center border-b">
          <Skeleton className="h-3 w-2/5" />
        </div>
      ))}
    </div>
  </DeskSection>
);

/**
 * Renders the Overview page at `/`, with Statistics first. Needs attention reads the overview
 * query, Statistics its own queries, and the other sections the desk query.
 */
export const Desk = () => {
  const { data: overview } = useSuspenseQuery(overviewQuery());
  const desk = useQuery(deskQuery());
  const now = useNow(15_000);
  const readOnly = overview._tag === "NeedsSetup";
  return (
    <Page width="full">
      <div className="flex flex-col gap-9 pb-2">
        <PageHeading
          title="Overview"
          counts={desk.data === undefined ? undefined : deskCounts(desk.data)}
        />
        {overview.projects.length === 0 && <NoProjects />}
        <Statistics />
        <DeskNeedsYou
          dismissedNeeds={overview.dismissedNeeds}
          needs={overview.needsYou}
          polls={desk.data?.polls ?? []}
          now={now}
        />
        {desk.data === undefined ? (
          desk.isError ? (
            <ErrorAlert title="Could not load the overview" message={desk.error.message} />
          ) : (
            <>
              <LoadingBlock id="desk-running" title="Running" />
              <LoadingBlock id="desk-not-moving" title="Stalled" />
              <LoadingBlock id="desk-outcomes" title="Recent runs" />
            </>
          )
        ) : (
          <>
            <DeskSection id="desk-running" title="Running" count={desk.data.running.length}>
              <RunningNow running={desk.data.running} workers={desk.data.workers} now={now} />
            </DeskSection>
            <DeskSection id="desk-not-moving" title="Stalled" count={desk.data.notMoving.length}>
              <NotMoving
                stalled={desk.data.notMoving}
                now={now}
                readOnly={readOnly}
                polled={desk.data.polls.some(({ polledAt }) => polledAt !== null)}
              />
            </DeskSection>
            <DeskSection id="desk-outcomes" title="Recent runs">
              <LastOutcomes outcomes={desk.data.lastOutcomes} now={now} />
            </DeskSection>
            {desk.data.workers.length > 0 && <WorkersLine workers={desk.data.workers} now={now} />}
          </>
        )}
      </div>
    </Page>
  );
};
