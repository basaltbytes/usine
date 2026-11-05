import { useQuery } from "@tanstack/react-query";
import type { ItemNumber } from "@usine/core/item";
import type { ProjectId } from "@usine/core/project";
import type { RepositoryName } from "@usine/core/repository";
import { AttemptFilesQuery, PullRequestFilesQuery } from "@usine/github/files";
import type { TaskItemView, TaskView } from "@usine/orchestrator/operator";
import { lazy, Suspense, useId, useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
import { Skeleton } from "~/components/ui/skeleton";
import { pullRequestFilesQuery } from "~/features/tasks/queries";
import {
  attemptChangesLabel,
  changesFailed,
  changesFor,
  changesTitle,
  checksState,
  compareChanges,
  loadingChanges,
  noChangedFiles,
  noRecordedAttempts,
  noRecordedHead,
  retryChanges,
  reviewState,
  truncatedFiles,
  wholePullRequest,
} from "~/features/tasks/strings";

const PullRequestDiff = lazy(() =>
  import("./diff").then(({ PullRequestDiff }) => ({ default: PullRequestDiff })),
);

const LoadingChanges = () => (
  <div role="status" aria-label={loadingChanges} className="space-y-2 py-2">
    <Skeleton className="h-8 w-full" />
    <Skeleton className="h-8 w-full" />
  </div>
);

type PullRequestFilesProps = {
  readonly project: ProjectId;
  readonly repository: RepositoryName;
  readonly number: ItemNumber;
  readonly state: NonNullable<TaskItemView["pullRequest"]>;
  readonly attempts: TaskView["attemptChanges"];
};

const PullRequestFiles = ({
  project,
  repository,
  number,
  state,
  attempts,
}: PullRequestFilesProps) => {
  const selectId = useId();
  const [selected, setSelected] = useState("whole");
  const attempt = attempts.find(({ attemptId }) => attemptId === selected);
  const selection =
    attempt === undefined
      ? PullRequestFilesQuery.make({ head: state.head })
      : AttemptFilesQuery.make({ first: attempt.first, head: attempt.head });
  const files = useQuery(pullRequestFilesQuery(project, repository, number, selection));
  return (
    <div className="min-w-0 space-y-3 pb-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor={selectId}>{compareChanges}</label>
          <NativeSelect
            id={selectId}
            value={attempt === undefined ? "whole" : selected}
            onChange={(event) => setSelected(event.target.value)}
            className="min-w-0 max-w-full"
          >
            <NativeSelectOption value="whole">{wholePullRequest}</NativeSelectOption>
            {attempts.map((attempt) => (
              <NativeSelectOption key={attempt.attemptId} value={attempt.attemptId}>
                {attemptChangesLabel(attempt.loop, attempt.number, attempt.head)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <a
          className="underline-offset-4 hover:underline"
          href={`https://github.com/${repository}/pull/${number}/checks`}
          target="_blank"
          rel="noreferrer"
        >
          {checksState(state.checks)}
        </a>
        <span>{reviewState(state.review)}</span>
      </div>
      {attempts.length === 0 && (
        <p className="text-xs text-muted-foreground">{noRecordedAttempts}</p>
      )}
      {files.isPending ? (
        <LoadingChanges />
      ) : files.isError ? (
        <div className="space-y-2">
          <ErrorAlert title={changesFailed} message={files.error.message} />
          <Button variant="outline" size="sm" onClick={() => void files.refetch()}>
            {retryChanges}
          </Button>
        </div>
      ) : (
        <>
          {files.data.filesTruncated && (
            <p role="status" className="text-xs text-muted-foreground">
              {truncatedFiles}
            </p>
          )}
          {files.data.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">{noChangedFiles}</p>
          ) : (
            <Suspense fallback={<LoadingChanges />}>
              <PullRequestDiff
                key={`${files.data.base}:${files.data.head}`}
                changes={files.data}
                repository={repository}
              />
            </Suspense>
          )}
        </>
      )}
    </div>
  );
};

type PullRequestChangesProps = {
  readonly project: ProjectId;
  readonly task: TaskView;
  readonly pullRequest: TaskItemView;
};

export const PullRequestChanges = ({ project, task, pullRequest }: PullRequestChangesProps) => {
  const [open, setOpen] = useState(false);
  return (
    <details className="min-w-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer py-2 text-sm font-medium focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
        {changesTitle}
      </summary>
      {open && (
        <section aria-label={changesFor(pullRequest.number)} className="min-w-0 pt-1">
          {pullRequest.pullRequest === null ? (
            <p className="pb-3 text-xs text-muted-foreground">{noRecordedHead}</p>
          ) : (
            <PullRequestFiles
              project={project}
              repository={task.repository}
              number={pullRequest.number}
              state={pullRequest.pullRequest}
              attempts={task.attemptChanges.filter(
                (attempt) => attempt.pullRequest === pullRequest.number,
              )}
            />
          )}
        </section>
      )}
    </details>
  );
};
