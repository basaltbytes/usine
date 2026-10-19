import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RunId } from "@usine/core/run";
import type { RunDetailView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { useMemo, useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { clockLabel, timestampLabel } from "./operator-copy.ts";
import { overviewQuery, projectParams } from "./overview.ts";
import { RunFacts, RunTitle } from "./run-page/header.tsx";
import { runItem } from "./run-page/item.ts";
import { RunActions } from "./run-intervention/actions.tsx";
import { EditAndRetry } from "./run-intervention/edit-and-retry.tsx";
import { CurrentActivity } from "./run-transcript/activity.tsx";
import { readerDocument, type AttemptEnd } from "./run-transcript/document/model.ts";
import { previewText } from "./run-transcript/document/text.ts";
import { projectTranscript } from "./run-transcript/model.ts";
import { Outcome } from "./run-transcript/outcome.tsx";
import { useRunDetail } from "./run-transcript/query.ts";

const LiveSummary = ({ detail }: { readonly detail: RunDetailView }) => {
  const document = useMemo(
    () =>
      readerDocument(
        projectTranscript(detail.transcript, detail.run.attempts, detail.sessionState),
        detail.run.attempts,
        detail.transcript,
      ),
    [detail.transcript, detail.sessionState, detail.run.attempts],
  );
  const chapter = [...document.chapters].reverse().find(({ live }) => live);
  const message = document.chapters
    .flatMap(({ rows }) => rows)
    .reverse()
    .find((row) => row._tag === "Message");
  return (
    <div className="space-y-4">
      {chapter === undefined ? (
        <p className="text-muted-foreground">The Attempt is starting on its Worker.</p>
      ) : (
        <CurrentActivity chapter={chapter} />
      )}
      {message?._tag === "Message" && (
        <section aria-label="Latest message" className="space-y-1">
          <p className="flex items-baseline gap-2 text-xs">
            <span className="font-medium">{message.speaker.name}</span>
            <time
              dateTime={message.receivedAt}
              title={timestampLabel(message.receivedAt)}
              className="font-mono tabular-nums text-muted-foreground"
            >
              {clockLabel(message.receivedAt)}
            </time>
          </p>
          <p className="line-clamp-6 text-md wrap-anywhere">{previewText(message.text)}</p>
        </section>
      )}
    </div>
  );
};

const finalEnd = (run: RunDetailView["run"]): Option.Option<AttemptEnd> => {
  const attempt = run.attempts.at(-1);
  const salvage = attempt?.salvage ?? null;
  if (run.state === "Succeeded")
    return Option.some({ _tag: "Succeeded", message: Option.fromNullishOr(run.resultMessage) });
  if (run.state === "Canceled") return Option.some({ _tag: "Canceled", salvage });
  if (run.state === "Failed" && attempt?.outcome?._tag === "Failed")
    return Option.some({ _tag: "Failed", failure: attempt.outcome.failure, salvage });
  return Option.none();
};

/** The drawer's one paragraph: the outcome or failure, what a live Run is doing, or what an open Run waits for. */
export const RunSummary = ({ detail }: { readonly detail: RunDetailView }) => {
  const run = detail.run;
  switch (run.state) {
    case "Pending":
      return <p className="text-muted-foreground">Opened; its Loop has not scheduled it yet.</p>;
    case "Waiting":
      return (
        <p className="text-muted-foreground">
          Waits for your approval. Approve to start an Attempt, or cancel the Run.
        </p>
      );
    case "Queued":
      return <p className="text-muted-foreground">Approved; waiting for a free Worker.</p>;
    case "Running":
      return <LiveSummary detail={detail} />;
    case "Succeeded":
    case "Failed":
    case "Canceled":
      return Option.match(finalEnd(run), {
        onNone: () => <p className="text-muted-foreground">No Attempt started.</p>,
        onSome: (end) => <Outcome end={end} />,
      });
  }
};

/** A short summary of one Run over any screen, with its actions and a link to the Run page. */
export const RunDrawer = ({
  runId,
  open,
  close,
}: {
  readonly runId: RunId;
  /** False keeps the last Run mounted while the Sheet plays its exit transition. */
  readonly open: boolean;
  readonly close: () => void;
}) => {
  const { data: overview } = useSuspenseQuery(overviewQuery());
  const detail = useRunDetail(runId, open);
  const [editing, setEditing] = useState(false);
  const run = detail.data?.run;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent
        side="right"
        aria-label="Run detail"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
      >
        <SheetHeader className="shrink-0 gap-3 border-b px-5 pt-5 pb-4 pr-12">
          {run === undefined || detail.data === undefined ? (
            <>
              <SheetTitle>Loading…</SheetTitle>
              <SheetDescription>Loading Run details…</SheetDescription>
            </>
          ) : (
            <>
              <RunTitle
                run={run}
                item={runItem(run, overview, detail.data.eventPayload)}
                heading={(title) => (
                  <SheetTitle className="text-lg font-semibold wrap-anywhere">{title}</SheetTitle>
                )}
              />
              <SheetDescription className="sr-only">
                Run {run.id} of {run.loop} on {run.repository}
              </SheetDescription>
              <RunFacts run={run} className="gap-x-4" />
              <RunActions run={run} onEdit={() => setEditing(true)} />
            </>
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {detail.isError && <ErrorAlert message={detail.error.message} />}
          {run !== undefined && editing && run.canRetry && (
            <EditAndRetry key={run.id} run={run} close={() => setEditing(false)} />
          )}
          {detail.data !== undefined && <RunSummary detail={detail.data} />}
          {run !== undefined && (
            <Link
              to="/projects/$owner/$name/runs/$run"
              params={{ ...projectParams(run.repository), run: run.id }}
              search={({ run: _run, ...rest }) => rest}
              className={buttonVariants({ variant: "outline" })}
            >
              Open Run
            </Link>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
