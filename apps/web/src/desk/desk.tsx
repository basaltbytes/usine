import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { NeedView, RepositoryPollView } from "@usine/orchestrator/operator";
import { ErrorAlert } from "@/components/error-alert";
import { Page, PageHeading } from "@/components/page";
import {
  ReloadConfigurationButton,
  ReloadOutcome,
  useReloadConfiguration,
} from "@/components/reload-configuration";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { NeedEntry } from "../needs-you/needs-you.tsx";
import { overviewQuery } from "../overview.ts";
import { deskCounts, lastCheckedLabel } from "./copy.ts";
import { LastOutcomes } from "./last-outcomes.tsx";
import { NotMoving } from "./not-moving.tsx";
import { deskQuery } from "./query.ts";
import { RunningNow } from "./running-now.tsx";
import { DeskSection, EmptyLine } from "./section.tsx";
import { WorkersLine } from "./workers-line.tsx";

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

export const DeskNeedsYou = ({
  needs,
  polls,
  now,
}: {
  readonly needs: ReadonlyArray<NeedView>;
  readonly polls: ReadonlyArray<RepositoryPollView>;
  readonly now: number;
}) => (
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
  </DeskSection>
);

const LoadingBlock = ({ id, title }: { readonly id: string; readonly title: string }) => (
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

/** Renders the Overview page at `/`. Needs attention reads the overview query; the other sections read the desk query. */
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
        <DeskNeedsYou needs={overview.needsYou} polls={desk.data?.polls ?? []} now={now} />
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
