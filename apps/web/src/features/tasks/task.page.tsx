import { useSuspenseQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { ItemNumber } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import type { ReactNode } from "react";
import { TaskNotFound } from "~/features/tasks/components/not-found";
import { ErrorAlert } from "~/components/error-alert";
import { useOpenRun } from "~/hooks/use-open-run";
import { overviewQuery, projectParams } from "~/lib/overview";
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
  const project = overview.projects.find((candidate) => candidate.repository === repository);
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
  if (view.number !== number)
    return (
      <Navigate
        to="/projects/$owner/$name/tasks/$number"
        params={{ ...projectParams(repository), number: String(view.number) }}
        search={(previous) => previous}
        replace
      />
    );
  return (
    <TaskLayout>
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
