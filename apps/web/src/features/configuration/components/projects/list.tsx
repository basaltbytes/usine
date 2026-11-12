import { Link, useNavigate } from "@tanstack/react-router";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import { RepositoryMark } from "~/components/repository-mark";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { ListEmpty } from "~/features/configuration/components/list-empty";
import {
  ConfigurationPage,
  OpeningRow,
  rowLinkClass,
} from "~/features/configuration/components/section";
import { emptyListCopy, plural, projectCopy } from "~/features/configuration/strings";

type ProjectRowProps = {
  readonly project: ConfigurationView["projects"][number];
  readonly loops: number;
};

const ProjectRow = ({ project, loops }: ProjectRowProps) => {
  const navigate = useNavigate();
  const params = { project: project.id };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/projects/$project", params })}>
      <TableCell className="py-3">
        <Link
          to="/configuration/projects/$project"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {project.name}
        </Link>
      </TableCell>
      <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
        {project.id}
      </TableCell>
      <FillCell className="whitespace-normal">
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {project.repositories.map((repository) => (
            <li key={repository} className="flex min-w-0 items-center gap-2">
              <RepositoryMark repository={repository} />
              <span className="wrap-anywhere">{repository}</span>
            </li>
          ))}
        </ul>
      </FillCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">
        {project.lanes.length === 0 ? (
          <span className="text-muted-foreground">Proposed</span>
        ) : (
          project.lanes.length
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {loops === 0 ? <span className="text-muted-foreground">None</span> : loops}
      </TableCell>
    </OpeningRow>
  );
};

type ProjectsListProps = { readonly configuration: ConfigurationView };

export const ProjectsList = ({ configuration }: ProjectsListProps) => (
  <ConfigurationPage
    title={projectCopy.title}
    createKind="project"
    empty={configuration.projects.length === 0}
    counts={plural(configuration.projects.length, "project")}
  >
    {configuration.projects.length === 0 ? (
      <ListEmpty {...emptyListCopy.project} />
    ) : (
      <div className="-mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Project</TableHead>
              <TableHead className="hidden sm:table-cell">ID</TableHead>
              <TableHead>Repositories</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Lanes</TableHead>
              <TableHead className="text-right">Loops</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configuration.projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                loops={
                  configuration.loops.filter(({ name }) => name.startsWith(`${project.id}/`)).length
                }
              />
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </ConfigurationPage>
);
