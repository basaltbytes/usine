import { useNavigate } from "@tanstack/react-router";
import type { FactoryOverview } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { CONFIGURATION_PAGES } from "~/components/configuration/navigation";
import { ItemHeading } from "~/components/item/heading";
import { cardIdentity } from "~/components/item/identity";
import { RepositoryMark } from "~/components/repository-mark";
import { CommandGroup, CommandItem } from "~/components/ui/command";
import { projectId, projectName } from "~/lib/overview";
import { useProjectLinks } from "~/hooks/use-project-links";
import { paletteCopy } from "./strings";

type NavigationCommandsProps = {
  readonly overview: FactoryOverview;
  readonly select: (run: () => void) => void;
  readonly searching: boolean;
};

export const NavigationCommands = ({ overview, select, searching }: NavigationCommandsProps) => {
  const navigate = useNavigate();
  const projectLinks = useProjectLinks();
  const tasks = new Map(
    overview.projects
      .flatMap(({ board }) => board.lanes.flatMap(({ items }) => items))
      .map((task) => [task.itemKey, task]),
  );
  const tasksByItem = new Map(
    [...tasks.values()].flatMap((task) =>
      task.items.map(({ itemKey }) => [itemKey, task] as const),
    ),
  );
  const runs = new Map(overview.projects.flatMap(({ runs }) => runs).map((run) => [run.id, run]));
  return (
    <>
      <CommandGroup heading={paletteCopy.navigation}>
        <CommandItem value="Overview" onSelect={() => select(() => void navigate({ to: "/" }))}>
          Overview
        </CommandItem>
        {CONFIGURATION_PAGES.map(({ to, label, icon: Icon }) => (
          <CommandItem
            key={to}
            value={`Configuration ${label}`}
            onSelect={() => select(() => void navigate({ to }))}
          >
            <Icon aria-hidden="true" />
            Configuration · {label}
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandGroup heading={paletteCopy.projects}>
        {overview.projects.flatMap((project) => [
          <CommandItem
            key={`${projectId(project)}:board`}
            value={`${projectName(project)} ${project.repositories.join(" ")} board`}
            onSelect={() =>
              select(
                () =>
                  void navigate({
                    to: "/projects/$project",
                    params: { project: projectId(project) },
                  }),
              )
            }
          >
            <RepositoryMark repository={project.repository} />
            {projectName(project)} · Board
          </CommandItem>,
          <CommandItem
            key={`${projectId(project)}:tasks`}
            value={`${projectName(project)} ${project.repositories.join(" ")} tasks`}
            onSelect={() =>
              select(
                () =>
                  void navigate({
                    to: "/projects/$project/tasks",
                    params: { project: projectId(project) },
                  }),
              )
            }
          >
            <RepositoryMark repository={project.repository} />
            {projectName(project)} · Tasks
          </CommandItem>,
        ])}
      </CommandGroup>
      {searching && (
        <>
          <CommandGroup heading={paletteCopy.tasks}>
            {[...tasks.values()].map((task) => {
              const { origin } = cardIdentity(task);
              return (
                <CommandItem
                  key={task.itemKey}
                  value={`task ${task.repository} ${task.items.map(({ number }) => `#${number}`).join(" ")} ${task.title}`}
                  onSelect={() =>
                    select(
                      () =>
                        void navigate(projectLinks.task(task.repository, String(origin.number))),
                    )
                  }
                >
                  <div className="min-w-0">
                    <ItemHeading
                      variant="row"
                      item={Option.some(origin)}
                      title={task.title}
                      linked={false}
                    />
                    <p className="text-muted-foreground">{task.repository}</p>
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandGroup heading={paletteCopy.runs}>
            {[...runs.values()].map((run) => {
              const task = tasksByItem.get(run.itemKey);
              return (
                <CommandItem
                  key={run.id}
                  value={`run ${run.id} ${run.loop} ${run.repository} ${task?.items.map(({ number }) => `#${number}`).join(" ") ?? ""}`}
                  onSelect={() =>
                    select(() => void navigate(projectLinks.run(run.repository, run.id)))
                  }
                >
                  <span className="min-w-0 truncate">
                    Run <span className="font-mono">{run.id.slice(0, 8)}</span> · {run.loop} ·{" "}
                    {run.repository}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </>
      )}
    </>
  );
};
