import { DismissedNeeds } from "~/features/overview/components/dismissed-needs";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { NeedView, RepositoryPollView } from "@usine/orchestrator/operator";
import { ErrorAlert } from "~/components/error-alert";
import { Page, PageHeading } from "~/components/page";
import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { useNow } from "~/hooks/use-now";
import { NeedEntry } from "~/components/needs-you/needs-you";
import { overviewQuery } from "~/lib/overview";
import {
  deskCounts,
  lastCheckedLabel,
  noProjectsCopy,
  overviewRefreshFailed,
} from "~/features/overview/strings";
import { LastOutcomes } from "~/features/overview/components/last-outcomes";
import { NotMoving } from "~/features/overview/components/not-moving";
import { deskQuery } from "~/lib/desk/queries";
import { RunningNow } from "~/features/overview/components/running-now";
import { DeskSection, EmptyLine } from "~/components/overview/section";
import { Statistics } from "~/features/overview/components/statistics/statistics";
import { WorkersLine } from "~/features/overview/components/workers-line";

const NoProjects = () => {
  return (
    <section className="flex flex-col items-start gap-3">
      <div className="flex max-w-prose flex-col gap-1">
        <h2 className="text-md font-medium">{noProjectsCopy.title}</h2>
        <p className="text-muted-foreground">{noProjectsCopy.description}</p>
      </div>
      <Button variant="outline" render={<Link to="/configuration/repositories" />}>
        {noProjectsCopy.action}
      </Button>
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

/**
 * Renders the Overview page at `/`, with Statistics first. Needs attention reads the overview
 * query, Statistics its own queries, and the other sections the desk query.
 */
export const Desk = () => {
  const { data: overview } = useSuspenseQuery(overviewQuery());
  const desk = useSuspenseQuery(deskQuery());
  const now = useNow(15_000);
  const readOnly = overview._tag === "NeedsSetup";
  return (
    <Page width="full">
      <div className="flex flex-col gap-9 pb-2">
        <PageHeading title="Overview" counts={deskCounts(desk.data)} />
        {overview.projects.length === 0 && <NoProjects />}
        <Statistics />
        <DeskNeedsYou
          dismissedNeeds={overview.dismissedNeeds}
          needs={overview.needsYou}
          polls={desk.data.polls}
          now={now}
        />
        {desk.isError && <ErrorAlert title={overviewRefreshFailed} message={desk.error.message} />}
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
      </div>
    </Page>
  );
};
