import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { ItemNumber } from "@usine/core/item";
import type { RepositoryName } from "@usine/core/repository";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Option, Schema } from "effect";
import type { ReactNode } from "react";
import { BootScreen } from "@/components/boot-screen";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenRun } from "../open-run.ts";
import { overviewQuery, projectParams } from "../overview.ts";
import { TaskComments } from "./comments.tsx";
import { TaskHeader } from "./header.tsx";
import { TaskPullRequests } from "./pull-requests.tsx";
import { taskQuery } from "./query.ts";
import { TaskRuns } from "./runs.tsx";

const decodeNumber = Schema.decodeUnknownOption(
  Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
);

const TaskNotFound = ({
  repository,
  number,
}: {
  readonly repository: RepositoryName;
  readonly number: string;
}) => (
  <BootScreen
    title="Task not found"
    description={`#${number} is not among the newest Items on the ${repository} Board, which Tasks are made from.`}
    tone="error"
    inPanel
  >
    <Button
      variant="outline"
      nativeButton={false}
      render={<Link to="/projects/$owner/$name" params={projectParams(repository)} />}
    >
      Back to the Board
    </Button>
  </BootScreen>
);

const TaskSkeleton = () => (
  <div aria-busy="true" aria-label="Loading the Task" className="flex flex-col gap-8">
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

const TaskLayout = ({ children }: { readonly children: ReactNode }) => (
  <main className="px-4 pt-5 pb-10 md:px-5">
    <div className="flex max-w-5xl flex-col gap-8">{children}</div>
  </main>
);

const TaskBody = ({
  repository,
  number,
}: {
  readonly repository: RepositoryName;
  readonly number: ItemNumber;
}) => {
  const { data: overview } = useSuspenseQuery(overviewQuery());
  const project = overview.projects.find((candidate) => candidate.repository === repository);
  const openRun = useOpenRun();
  const task = useQuery(taskQuery(repository, number));
  if (task.error instanceof OperatorHttpError && task.error.error === "BoardItemNotFoundError")
    return <TaskNotFound repository={repository} number={String(number)} />;
  const failure = task.isError && (
    <ErrorAlert
      className="max-w-3xl"
      title={
        task.data === undefined ? "The Task could not be read" : "The Task could not be refreshed"
      }
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

/**
 * One Task: its originating Item and lane, every Run on its Items with their actions, its pull
 * requests, and the comments and reviews its Runs posted. A number of any of its Items opens it;
 * the address then names the originating Item.
 */
export const TaskPage = ({
  repository,
  number,
}: {
  readonly repository: RepositoryName;
  /** The Item number from the address, not yet known to be one. */
  readonly number: string;
}) =>
  Option.match(decodeNumber(number), {
    onNone: () => <TaskNotFound repository={repository} number={number} />,
    onSome: (item) => <TaskBody repository={repository} number={item} />,
  });
