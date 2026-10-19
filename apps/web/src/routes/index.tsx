import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { ProjectView } from "@usine/orchestrator/operator";
import { Page, PageHeading } from "@/components/page";
import {
  ReloadConfigurationButton,
  ReloadOutcome,
  useReloadConfiguration,
} from "@/components/reload-configuration";
import { NeedsYouBadge, StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { openRunsLabel } from "../operator-copy.ts";
import { needsYouByProject, overviewQuery, projectParams } from "../overview.ts";

const STATUS_LABEL = { clear: "Clear", active: "Active" } as const;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

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

const ProjectRow = ({
  project,
  needsYou,
}: {
  readonly project: ProjectView;
  readonly needsYou: number;
}) => {
  const navigate = useNavigate();
  const params = projectParams(project.repository);
  const items = project.board.lanes.reduce((total, lane) => total + lane.items.length, 0);
  const lanes = project.board.lanes.length;
  const openRuns = openRunsLabel(project.runs);
  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60"
      onClick={() => void navigate({ to: "/projects/$owner/$name", params })}
    >
      <TableCell className="w-full py-3 whitespace-normal">
        <Link
          to="/projects/$owner/$name"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className="rounded-sm font-medium wrap-anywhere outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid"
        >
          {project.repository}
        </Link>
        <p className="text-xs text-muted-foreground tabular-nums sm:hidden">
          {plural(items, "item")}, {plural(lanes, "lane")}
        </p>
      </TableCell>
      <TableCell>
        {project.status === "needs-you" || needsYou > 0 ? (
          <NeedsYouBadge count={needsYou} />
        ) : (
          <StatusBadge state={project.status} label={STATUS_LABEL[project.status]} />
        )}
      </TableCell>
      <TableCell
        className={
          openRuns === "None"
            ? "text-muted-foreground"
            : "whitespace-normal tabular-nums sm:whitespace-nowrap"
        }
      >
        {openRuns}
      </TableCell>
      <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
        {items}
      </TableCell>
      <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
        {lanes}
      </TableCell>
    </TableRow>
  );
};

const ProjectIndex = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  const projects = data.projects;
  const needsYou = needsYouByProject(data.needsYou);
  return (
    <Page>
      <PageHeading
        title="Projects"
        counts={projects.length === 0 ? undefined : plural(projects.length, "project")}
      />
      {projects.length === 0 ? (
        <NoProjects />
      ) : (
        <div className="-mx-2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Repository</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Open Runs</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Items</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Lanes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => (
                <ProjectRow
                  key={project.repository}
                  project={project}
                  needsYou={needsYou.get(project.repository) ?? 0}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
};

export const Route = createFileRoute("/")({ component: ProjectIndex });
