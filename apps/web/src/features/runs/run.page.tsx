import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RunId } from "@usine/core/run";
import { useState } from "react";
import { runDetailQuery } from "~/lib/runs/queries";
import { ErrorAlert } from "~/components/error-alert";
import { overviewQuery, projectParams } from "~/lib/overview";
import { ContextualActions } from "~/components/runs/intervention/contextual-actions";
import {
  EditAndRetry,
  type EditIntent,
  editApplies,
} from "~/components/runs/intervention/edit-and-retry";
import { useEarlierTranscript } from "~/hooks/runs/transcript";
import { RunHeader } from "~/components/runs/header";
import { RunWorkspace } from "~/features/runs/components/workspace";

type RunPageProps = { readonly runId: RunId };

export const RunPage = ({ runId }: RunPageProps) => {
  const { data: overview } = useSuspenseQuery(overviewQuery());
  const queryClient = useQueryClient();
  const detail = useSuspenseQuery(runDetailQuery(queryClient, runId));
  const earlier = useEarlierTranscript(runId);
  const [editing, setEditing] = useState<EditIntent | null>(null);
  const navigate = useNavigate();
  if (detail.isError)
    return <ErrorAlert className="m-4 max-w-3xl md:m-5" message={detail.error.message} />;
  const run = detail.data.run;
  const openRun = (opened: RunId) => {
    setEditing(null);
    void navigate({
      to: "/projects/$project/$name/runs/$run",
      params: { ...projectParams(run.repository), run: opened },
    });
  };
  return (
    <main className="flex min-h-[36rem] flex-1 flex-col">
      <RunHeader
        detail={detail.data}
        overview={overview}
        placement="page"
        shared
        className="px-4 pt-4 pb-4 md:px-5"
        actions={<ContextualActions detail={detail.data} onEdit={setEditing} openRun={openRun} />}
      />
      {editing !== null && editApplies(run, editing) && (
        <EditAndRetry
          key={`${run.id}:${editing}`}
          run={run}
          intent={editing}
          close={() => setEditing(null)}
          openRun={openRun}
          className="mx-4 mb-4 max-w-2xl rounded-lg border p-4 md:mx-5"
        />
      )}
      <RunWorkspace
        detail={detail.data}
        history={{
          cursors: detail.data.earlierTranscript,
          loading: earlier.isPending,
          error: earlier.isError ? earlier.error.message : null,
          load: (cursor) => earlier.mutate(cursor),
        }}
      />
    </main>
  );
};
