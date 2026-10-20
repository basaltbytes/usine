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
        <h2 className="text-md font-medium">No Projects registered</h2>
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

/** Everything that waits on the operator, or a line saying nothing does and when polling last checked. */
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
    title="Needs you"
    count={needs.length}
    countTone="needs-you"
    note={lastCheckedLabel(polls, now) ?? undefined}
  >
    {needs.length === 0 ? (
      <EmptyLine>Nothing waits on you.</EmptyLine>
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

/**
 * The page at `/`: Needs you, Running now, Not moving, and Last outcomes in reading order, then
 * the Workers in one line. Needs you comes from the overview; the other blocks from the desk.
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
          title="Desk"
          counts={desk.data === undefined ? undefined : deskCounts(desk.data)}
        />
        {overview.projects.length === 0 && <NoProjects />}
        <DeskNeedsYou needs={overview.needsYou} polls={desk.data?.polls ?? []} now={now} />
        {desk.data === undefined ? (
          desk.isError ? (
            <ErrorAlert title="The desk could not be loaded" message={desk.error.message} />
          ) : (
            <>
              <LoadingBlock id="desk-running" title="Running now" />
              <LoadingBlock id="desk-not-moving" title="Not moving" />
              <LoadingBlock id="desk-outcomes" title="Last outcomes" />
            </>
          )
        ) : (
          <>
            <DeskSection id="desk-running" title="Running now" count={desk.data.running.length}>
              <RunningNow running={desk.data.running} workers={desk.data.workers} now={now} />
            </DeskSection>
            <DeskSection id="desk-not-moving" title="Not moving" count={desk.data.notMoving.length}>
              <NotMoving
                stalled={desk.data.notMoving}
                now={now}
                readOnly={readOnly}
                polled={desk.data.polls.some(({ polledAt }) => polledAt !== null)}
              />
            </DeskSection>
            <DeskSection id="desk-outcomes" title="Last outcomes">
              <LastOutcomes outcomes={desk.data.lastOutcomes} now={now} />
            </DeskSection>
            {desk.data.workers.length > 0 && <WorkersLine workers={desk.data.workers} now={now} />}
          </>
        )}
      </div>
    </Page>
  );
};
