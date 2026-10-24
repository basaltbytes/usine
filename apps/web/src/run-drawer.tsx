import { ArrowsOutSimpleIcon } from "@phosphor-icons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RunId } from "@usine/core/run";
import type { RunDetailView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { useMemo, useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { clockLabel, queuedMessageLabel, timestampLabel } from "./operator-copy.ts";
import { overviewQuery, projectParams } from "./overview.ts";
import { RunFacts, RunTitle, WorkFacts } from "./run-page/header.tsx";
import { runItem } from "./run-page/item.ts";
import { RunActions } from "./run-intervention/actions.tsx";
import { EditAndRetry, type EditIntent, editApplies } from "./run-intervention/edit-and-retry.tsx";
import { useOpenRun } from "./open-run.ts";
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
        <p className="text-muted-foreground">Attempt starting</p>
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
          {message.queued !== null && (
            <p className="text-xs text-muted-foreground">{queuedMessageLabel(message.queued)}</p>
          )}
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

export const RunSummary = ({ detail }: { readonly detail: RunDetailView }) => {
  const run = detail.run;
  switch (run.state) {
    case "Pending":
      return <p className="text-muted-foreground">Opened, not scheduled yet</p>;
    case "Waiting":
      return <p className="text-muted-foreground">Waiting for approval</p>;
    case "Queued":
      return <p className="text-muted-foreground">Approved, waiting for a free worker</p>;
    case "Running":
      return <LiveSummary detail={detail} />;
    case "Succeeded":
    case "Failed":
    case "Canceled":
      return Option.match(finalEnd(run), {
        onNone: () => <p className="text-muted-foreground">No attempt started</p>,
        onSome: (end) => <Outcome end={end} />,
      });
  }
};

export const RunDrawer = ({
  runId,
  open,
  close,
}: {
  readonly runId: RunId;
  /** If `false`, the last Run stays mounted until the Sheet's exit transition ends. */
  readonly open: boolean;
  readonly close: () => void;
}) => {
  const { data: overview } = useSuspenseQuery(overviewQuery());
  const detail = useRunDetail(runId, open);
  const [editing, setEditing] = useState<EditIntent | null>(null);
  const openRun = useOpenRun();
  const run = detail.data?.run;
  const item =
    detail.data === undefined
      ? Option.none()
      : runItem(detail.data.run, overview, detail.data.eventPayload);
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
        <SheetHeader className="shrink-0 gap-3 border-b px-5 pt-5 pb-4 pr-20">
          {run === undefined || detail.data === undefined ? (
            <>
              <SheetTitle>Loading…</SheetTitle>
              <SheetDescription>Loading run…</SheetDescription>
            </>
          ) : (
            <>
              <RunTitle
                run={run}
                item={item}
                shared={open}
                heading={(title) => (
                  <SheetTitle className="text-lg font-semibold wrap-anywhere">{title}</SheetTitle>
                )}
              />
              <SheetDescription className="sr-only">
                Run {run.id} of {run.loop} on {run.repository}
              </SheetDescription>
              <div className="space-y-1">
                <RunFacts
                  run={run}
                  item={item}
                  settledItemState={detail.data.settledItemState}
                  shared={open}
                  className="gap-x-4"
                />
                <WorkFacts detail={detail.data} showUsage={false} className="gap-x-4" />
              </div>
              <RunActions run={run} onEdit={setEditing} openRun={openRun} />
            </>
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {detail.isError && <ErrorAlert message={detail.error.message} />}
          {run !== undefined && editing !== null && editApplies(run, editing) && (
            <EditAndRetry
              key={`${run.id}:${editing}`}
              run={run}
              intent={editing}
              close={() => setEditing(null)}
              openRun={openRun}
            />
          )}
          {detail.data !== undefined && <RunSummary detail={detail.data} />}
          {run !== undefined && (
            <Link
              to="/projects/$owner/$name/runs/$run"
              params={{ ...projectParams(run.repository), run: run.id }}
              search={{}}
              viewTransition
              className={buttonVariants({ variant: "outline" })}
            >
              Open run page
            </Link>
          )}
        </div>
        {run !== undefined && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  to="/projects/$owner/$name/runs/$run"
                  params={{ ...projectParams(run.repository), run: run.id }}
                  search={{}}
                  viewTransition
                  aria-label="Open run page"
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "icon-sm" }),
                    "absolute top-4 right-11",
                  )}
                />
              }
            >
              <ArrowsOutSimpleIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Open run page</TooltipContent>
          </Tooltip>
        )}
      </SheetContent>
    </Sheet>
  );
};
