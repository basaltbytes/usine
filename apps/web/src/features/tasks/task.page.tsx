import { RepositoryFilter } from "~/components/repository-filter";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import type { ItemNumber } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import type { ReactNode } from "react";
import { TaskNotFound } from "~/features/tasks/components/not-found";
import { ErrorAlert } from "~/components/error-alert";
import { useOpenRun } from "~/hooks/use-open-run";
import { overviewQuery, projectId, projectForRepository } from "~/lib/overview";
import { TaskComments } from "~/features/tasks/components/comments";
import { TaskHeader } from "~/features/tasks/components/header";
import { TaskPullRequests } from "~/features/tasks/components/pull-requests";
import { taskQuery } from "~/features/tasks/queries";
import { TaskRuns } from "~/features/tasks/components/runs/runs";

type TaskLayoutProps = { readonly children: ReactNode };

const TaskLayout = ({ children }: TaskLayoutProps) => (
  <main className="px-4 pt-5 pb-10 md:px-5">
    <div className="flex max-w-5xl flex-col gap-8">{children}</div>
  </main>
);

type TaskPageProps = {
  readonly repository: RepositoryName;
  readonly number: ItemNumber;
};

export const TaskPage = ({ repository, number }: TaskPageProps) => {
  const { data: overview } = useSuspenseQuery(overviewQuery());
  const project = projectForRepository(overview.projects, repository);
  const navigate = useNavigate();
  const openRun = useOpenRun();
  const task = useSuspenseQuery(taskQuery(repository, number));
  if (task.error instanceof OperatorHttpError && task.error.error === "BoardItemNotFoundError")
    return <TaskNotFound repository={repository} number={String(number)} />;
  const failure = task.isError && (
    <ErrorAlert
      className="max-w-3xl"
      title="Could not refresh the task"
      message={task.error.message}
    />
  );
  const view = task.data;
  if (view.number !== number && project !== undefined)
    return (
      <Navigate
        to="/projects/$project/tasks/$number"
        params={{ project: projectId(project), number: String(view.number) }}
        search={(previous) => ({ ...previous, repository })}
        replace
      />
    );
  return (
    <TaskLayout>
      {project !== undefined && project.repositories.length > 1 && (
        <RepositoryFilter
          repositories={project.repositories}
          value={repository}
          onChange={(repository) =>
            void navigate({
              to: "/projects/$project/tasks",
              params: { project: projectId(project) },
              search: { repository },
            })
          }
        />
      )}
      {failure}
      {project !== undefined && (
        <TaskHeader task={view} project={project} disabled={overview._tag === "NeedsSetup"} />
      )}
      <TaskRuns task={view} openRun={openRun} />
      <TaskPullRequests task={view} />
      <TaskComments task={view} />
    </TaskLayout>
  );
};
