import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunId } from "@usine/core/run";
import {
  ColdTranscriptRequest,
  EarlierTranscriptRequest,
  TailTranscriptRequest,
  RunDetailView,
  type TranscriptPageCursor,
} from "@usine/orchestrator/operator";
import { useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { Markdown } from "@/components/markdown";
import { RunLinks } from "@/components/run-links";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemHeader,
  ItemTitle,
} from "@/components/ui/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { api } from "./api.ts";
import {
  brainLine,
  elapsedLabel,
  failureMessage,
  runActionLabel,
  salvageMessage,
} from "./operator-copy.ts";
import { type RunActionRequest, useRunAction } from "./run-actions.ts";
import {
  mergeTranscript,
  mergeEarlierTranscript,
  poolMeters,
  RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
} from "./run-transcript/cache.ts";
import { Conversation } from "./run-transcript/conversation.tsx";
import { fetchRunDetail } from "./run-transcript/fetch.ts";
import { EditAndRetry } from "./run-intervention/edit-and-retry.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

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
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [activeTab, setActiveTab] = useState("conversation");
  const [editing, setEditing] = useState(false);
  const detail = useQuery<RunDetailView>({
    queryKey: ["run", runId],
    queryFn: async () => {
      const key = ["run", runId] as const;
      const previous = queryClient.getQueryData<RunDetailView>(key);
      const cursor = previous?.transcript.at(-1)?.sequence;
      const next = await fetchRunDetail(
        cursor === undefined
          ? new ColdTranscriptRequest()
          : new TailTranscriptRequest({ after: cursor }),
        (query) => api((client) => client.detail({ params: { runId }, query })),
      );
      const current = queryClient.getQueryData<RunDetailView>(key);
      if (cursor === undefined || current === undefined) return next;
      return new RunDetailView({
        ...next,
        transcript: mergeTranscript(current.transcript, next.transcript),
        earlierTranscript: current.earlierTranscript,
      });
    },
    structuralSharing: RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
    enabled: open,
    refetchInterval: (query) => (query.state.data?.run.canCancel === true ? 1_000 : false),
  });
  const mutation = useRunAction();
  const act = (request: RunActionRequest) =>
    mutation.mutate({ runId, request }, { onSuccess: () => setConfirmCancel(false) });
  const earlierMutation = useMutation({
    mutationFn: (cursor: TranscriptPageCursor) =>
      api((client) =>
        client.detail({ params: { runId }, query: new EarlierTranscriptRequest(cursor) }),
      ),
    onSuccess: (page, cursor) => {
      const key = ["run", runId] as const;
      queryClient.setQueryData<RunDetailView>(key, (previous) =>
        previous === undefined ? previous : mergeEarlierTranscript(previous, page, cursor),
      );
    },
  });
  const run = detail.data?.run;
  const latestAttempt = run?.attempts.at(-1);
  const earlier = detail.data?.earlierTranscript.at(-1);
  const meters = poolMeters(detail.data?.transcript ?? []);
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
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
      >
        <SheetHeader className="shrink-0 gap-2 border-b px-4 py-4 pr-12 sm:px-6 sm:pr-14">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>{run?.loop ?? "Loading…"}</SheetTitle>
            {run !== undefined && <StatusBadge state={run.state} />}
            {run?.loopPaused && <Badge variant="outline">Loop paused</Badge>}
          </div>
          <SheetDescription className="font-mono wrap-anywhere">
            {run?.repository ?? "Loading Run details…"}
          </SheetDescription>
          {run !== undefined && <RunLinks run={run} />}
        </SheetHeader>
        {detail.isError && <ErrorAlert className="mx-4 my-3" message={detail.error.message} />}
        {run !== undefined && detail.data !== undefined && (
          <>
            {(run.canApprove || run.canRetry || run.canCancel) && (
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6">
                <span className="mr-auto text-muted-foreground">
                  {run.state === "Queued" ? "Waiting for a free worker" : run.agent}
                </span>
                {run.canApprove && (
                  <Button
                    size="sm"
                    disabled={mutation.isPending}
                    onClick={() => act({ action: "approve" })}
                  >
                    {runActionLabel.approve}
                  </Button>
                )}
                {run.canResolveFailure && latestAttempt !== undefined && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={mutation.isPending}
                    onClick={() => act({ action: "resolveFailure", attemptId: latestAttempt.id })}
                  >
                    {latestAttempt.outcome?._tag === "Failed" &&
                    latestAttempt.outcome.failure._tag === "QuestionFailure"
                      ? "Mark answered"
                      : "Mark resolved"}
                  </Button>
                )}
                {run.canRetry && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={mutation.isPending}
                    onClick={() => act({ action: "retry" })}
                  >
                    {runActionLabel.retry}
                  </Button>
                )}
                {run.canCancel && (
                  <Button
                    size="sm"
                    variant={confirmCancel ? "destructive" : "outline"}
                    disabled={mutation.isPending}
                    onClick={() =>
                      confirmCancel ? act({ action: "cancel" }) : setConfirmCancel(true)
                    }
                  >
                    {confirmCancel ? runActionLabel.confirmCancel : runActionLabel.cancel}
                  </Button>
                )}
                {run.canRetry && (
                  <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                    Edit and retry
                  </Button>
                )}
                {confirmCancel && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={mutation.isPending}
                    onClick={() => setConfirmCancel(false)}
                  >
                    {runActionLabel.keepRunning}
                  </Button>
                )}
              </div>
            )}
            {mutation.isError && (
              <ErrorAlert className="mx-4 my-3" message={mutation.error.message} />
            )}
            {editing && run.canRetry && (
              <EditAndRetry key={run.id} run={run} close={() => setEditing(false)} />
            )}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
              <TabsList
                variant="line"
                className="w-full shrink-0 justify-start gap-2 border-b px-4 sm:px-6"
                aria-label="Run views"
              >
                <TabsTrigger value="conversation" className="flex-none">
                  Conversation
                </TabsTrigger>
                <TabsTrigger value="task" className="flex-none">
                  Task
                </TabsTrigger>
                <TabsTrigger value="event" className="flex-none">
                  Event
                </TabsTrigger>
                <TabsTrigger value="attempts" className="flex-none">
                  Attempts ({run.attempts.length})
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="conversation"
                keepMounted
                className="flex min-h-0 flex-col data-[hidden]:hidden"
              >
                <Conversation
                  key={runId}
                  runId={runId}
                  events={detail.data.transcript}
                  sessionState={detail.data.sessionState}
                  attempts={run.attempts}
                  earlier={earlier}
                  loadEarlier={() => {
                    if (earlier !== undefined) earlierMutation.mutate(earlier);
                  }}
                  loadingEarlier={earlierMutation.isPending}
                  earlierError={earlierMutation.isError ? earlierMutation.error.message : null}
                  state={run.state}
                  active={open && activeTab === "conversation"}
                />
              </TabsContent>
              <TabsContent value="task" className="min-h-0 overflow-y-auto p-4 sm:p-6">
                <h3 className="mb-3 font-heading text-sm">Task</h3>
                <Markdown className="max-w-prose">{run.task}</Markdown>
              </TabsContent>
              <TabsContent value="event" className="min-h-0 overflow-y-auto p-4 sm:p-6">
                <h3 className="mb-3 font-heading text-sm">Triggering Event</h3>
                <p className="mb-3 font-mono text-muted-foreground wrap-anywhere">
                  {detail.data.eventDedupKey}
                </p>
                <pre className="font-mono text-xs/relaxed whitespace-pre-wrap wrap-anywhere">
                  {JSON.stringify(detail.data.eventPayload, null, 2)}
                </pre>
              </TabsContent>
              <TabsContent value="attempts" className="min-h-0 overflow-y-auto p-4 sm:p-6">
                <p className="mb-4 font-mono text-muted-foreground wrap-anywhere">Run {run.id}</p>
                {meters.length > 0 && (
                  <div className="mb-4 space-y-2">
                    <h3 className="font-heading text-sm">Account rate windows</h3>
                    <div className="flex flex-wrap gap-2">
                      {meters.map((meter) => (
                        <Badge key={meter.pool} variant="outline" className="font-mono">
                          {meter.pool}
                          {meter.primaryUsedPercent !== null &&
                            ` · primary ${meter.primaryUsedPercent}% used`}
                          {meter.secondaryUsedPercent !== null &&
                            ` · secondary ${meter.secondaryUsedPercent}% used`}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {run.attempts.length === 0 && (
                  <p className="text-muted-foreground">No attempt has started.</p>
                )}
                <ItemGroup className="gap-2">
                  {run.attempts.map((attempt) => (
                    <Item variant="muted" size="sm" key={attempt.id}>
                      <ItemHeader>
                        <ItemTitle>Attempt {attempt.number}</ItemTitle>
                        <StatusBadge state={attempt.outcome?._tag ?? "Running"} />
                      </ItemHeader>
                      <ItemContent>
                        <ItemDescription className="font-mono">
                          {attempt.agent} · {attempt.worker} · {brainLine(attempt.brain)} ·{" "}
                          {elapsedLabel(attempt.startedAt)}
                        </ItemDescription>
                        {attempt.operatorIntervened && (
                          <Badge variant="outline">Operator intervened</Badge>
                        )}
                        <Collapsible>
                          <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
                            Task used by this attempt
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <Markdown>{attempt.task}</Markdown>
                          </CollapsibleContent>
                        </Collapsible>
                        {attempt.outcome?._tag === "Failed" && (
                          <p className="text-destructive wrap-anywhere">
                            <strong>{attempt.outcome.failure._tag}</strong>
                            {` — ${failureMessage(attempt.outcome.failure)}`}
                          </p>
                        )}
                        {attempt.salvage !== null && (
                          <p className="font-mono text-muted-foreground wrap-anywhere">
                            {salvageMessage(attempt.salvage)}
                          </p>
                        )}
                      </ItemContent>
                    </Item>
                  ))}
                </ItemGroup>
                {run.resultMessage !== null && (
                  <section className="mt-6">
                    <h3 className="mb-3 font-heading text-sm">Result</h3>
                    <Markdown className="max-w-prose">{run.resultMessage}</Markdown>
                  </section>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
};
