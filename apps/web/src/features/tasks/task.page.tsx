import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { ItemNumber } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Option, Schema } from "effect";
import type { ReactNode } from "react";
import { BootScreen } from "~/components/boot-screen";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useOpenRun } from "~/hooks/use-open-run";
import { overviewQuery, projectParams } from "~/lib/overview";
import { TaskComments } from "~/features/tasks/components/comments";
import { TaskHeader } from "~/features/tasks/components/header";
import { TaskPullRequests } from "~/features/tasks/components/pull-requests";
import { taskQuery } from "~/features/tasks/queries";
import { TaskRuns } from "~/features/tasks/components/runs/runs";

const decodeNumber = Schema.decodeUnknownOption(
  Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
);

type TaskNotFoundProps = {
  readonly repository: RepositoryName;
  readonly number: string;
};

const TaskNotFound = ({ repository, number }: TaskNotFoundProps) => (
  <BootScreen
    title="Task not found"
    description={`#${number} is not among the newest items on the ${repository} board`}
    tone="error"
    inPanel
  >
    <Button
      variant="outline"
      nativeButton={false}
      render={<Link to="/projects/$owner/$name" params={projectParams(repository)} />}
    >
      Back to the board
    </Button>
  </BootScreen>
);

const TaskSkeleton = () => (
  <div aria-busy="true" aria-label="Loading the task" className="flex flex-col gap-8">
    <div className="flex flex-col gap-2.5">
      <Skeleton className="h-7 w-2/3 max-w-xl" />
      <Skeleton className="h-4 w-1/2 max-w-sm" />
    </div>
    <div className="flex flex-col gap-3">
      <Skeleton className="h-6 w-24" />
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-10 w-full" />
      ))}
    </div>
  </div>
);

type TaskLayoutProps = { readonly children: ReactNode };

const TaskLayout = ({ children }: TaskLayoutProps) => (
  <main className="px-4 pt-5 pb-10 md:px-5">
    <div className="flex max-w-5xl flex-col gap-8">{children}</div>
  </main>
);

type TaskBodyProps = {
  readonly repository: RepositoryName;
  readonly number: ItemNumber;
};

const TaskBody = ({ repository, number }: TaskBodyProps) => {
  const { data: overview } = useSuspenseQuery(overviewQuery());
  const project = overview.projects.find((candidate) => candidate.repository === repository);
  const openRun = useOpenRun();
  const task = useQuery(taskQuery(repository, number));
  if (task.error instanceof OperatorHttpError && task.error.error === "BoardItemNotFoundError")
    return <TaskNotFound repository={repository} number={String(number)} />;
  const failure = task.isError && (
    <ErrorAlert
      className="max-w-3xl"
      title={task.data === undefined ? "Could not load the task" : "Could not refresh the task"}
      message={task.error.message}
    />
  );
  const view = task.data;
  if (view === undefined)
    return <TaskLayout>{failure === false ? <TaskSkeleton /> : failure}</TaskLayout>;
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

type TaskPageProps = {
  readonly repository: RepositoryName;
  /** Item number from the URL, not yet validated. */
  readonly number: string;
};

/** Opens for the number of any of the Task's Items; the URL then uses the originating Item's number. */
export const TaskPage = ({ repository, number }: TaskPageProps) =>
  Option.match(decodeNumber(number), {
    onNone: () => <TaskNotFound repository={repository} number={number} />,
    onSome: (item) => <TaskBody repository={repository} number={item} />,
  });
