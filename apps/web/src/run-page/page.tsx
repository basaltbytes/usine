import { useSuspenseQuery } from "@tanstack/react-query";
import type { RunId } from "@usine/core/run";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { overviewQuery } from "../overview.ts";
import { RunActions } from "../run-intervention/actions.tsx";
import { EditAndRetry } from "../run-intervention/edit-and-retry.tsx";
import { useEarlierTranscript, useRunDetail } from "../run-transcript/query.ts";
import { RunFacts, RunTitle } from "./header.tsx";
import { runItem } from "./item.ts";
import { RunWorkspace } from "./workspace.tsx";

/** The whole Run: its header and actions, then the outline of its parts beside the reader. */
export const RunPage = ({ runId }: { readonly runId: RunId }) => {
  const { data: overview } = useSuspenseQuery(overviewQuery());
  const detail = useRunDetail(runId, true);
  const earlier = useEarlierTranscript(runId);
  const [editing, setEditing] = useState(false);
  if (detail.isError)
    return <ErrorAlert className="m-4 max-w-3xl md:m-5" message={detail.error.message} />;
  if (detail.data === undefined)
    return <p className="px-4 py-5 text-muted-foreground md:px-5">Loading Run…</p>;
  const run = detail.data.run;
  const item = runItem(run, overview, detail.data.eventPayload);
  return (
    <main className="flex min-h-[36rem] flex-1 flex-col">
      <header className="flex flex-col gap-3 px-4 pt-4 pb-4 md:px-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="min-w-0 space-y-1.5">
          <RunTitle
            run={run}
            item={item}
            shared
            heading={(title) => <h1 className="text-xl font-semibold wrap-anywhere">{title}</h1>}
          />
          <RunFacts run={run} item={item} shared />
        </div>
        <RunActions run={run} onEdit={() => setEditing(true)} className="lg:shrink-0" />
      </header>
      {editing && run.canRetry && (
        <EditAndRetry
          key={run.id}
          run={run}
          close={() => setEditing(false)}
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
