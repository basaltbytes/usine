import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Run } from "@usine/core";
import { RunDetailView } from "@usine/orchestrator";
import type { TranscriptPageCursor } from "@usine/orchestrator";
import type { Schema } from "effect";
import { useState, type ReactNode } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { Markdown } from "@/components/markdown";
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
import { ApiOk, api } from "./api.ts";
import { brainLine, failureMessage } from "./operator-copy.ts";
import {
  mergeTranscript,
  poolMeters,
  replaceEarlierCursor,
  RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
  Transcript,
} from "./run-transcript.tsx";

/** Opens the drawer over the current screen by writing the run id into the root search. */
export const useOpenRun = () => {
  const navigate = useNavigate();
  return (runId: Run.RunId) =>
    void navigate({ to: ".", search: (previous) => ({ ...previous, run: runId }) });
};

const timeAgo = (value: string): string => {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
};

const jsonGist = (value: Schema.Json): string => JSON.stringify(value, null, 2);

const Section = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <section className="border-b px-6 py-4">
    <h3 className="mb-2 font-heading text-[0.625rem] font-medium text-muted-foreground">{title}</h3>
    {children}
  </section>
);

export const RunDrawer = ({
  runId,
  close,
}: {
  readonly runId: Run.RunId;
  readonly close: () => void;
}) => {
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const detail = useQuery<RunDetailView>({
    queryKey: ["run", runId],
    queryFn: async () => {
      const key = ["run", runId] as const;
      const previous = queryClient.getQueryData<RunDetailView>(key);
      const cursor = previous?.transcript.at(-1)?.sequence;
      const search = cursor === undefined ? "" : `?after=${cursor}`;
      const next = await api(`/api/runs/${encodeURIComponent(runId)}${search}`, RunDetailView);
      const current = queryClient.getQueryData<RunDetailView>(key);
      if (cursor === undefined || current === undefined) return next;
      return new RunDetailView({
        ...next,
        transcript: mergeTranscript(current.transcript, next.transcript),
        earlierTranscript: current.earlierTranscript,
      });
    },
    structuralSharing: RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
    refetchInterval: (query) => (query.state.data?.run.canCancel === true ? 1_000 : false),
  });
  const mutation = useMutation({
    mutationFn: (act: "approve" | "retry" | "cancel") =>
      api(`/api/runs/${encodeURIComponent(runId)}/${act}`, ApiOk, {
        method: "POST",
      }),
    onSuccess: async () => {
      setConfirmCancel(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
      ]);
    },
  });
  const earlierMutation = useMutation({
    mutationFn: (cursor: TranscriptPageCursor) =>
      api(
        `/api/runs/${encodeURIComponent(runId)}?attempt=${encodeURIComponent(cursor.attemptId)}&before=${cursor.before}`,
        RunDetailView,
      ),
    onSuccess: (page, cursor) => {
      const key = ["run", runId] as const;
      queryClient.setQueryData<RunDetailView>(key, (previous) =>
        previous === undefined
          ? previous
          : new RunDetailView({
              ...page,
              transcript: mergeTranscript(previous.transcript, page.transcript),
              earlierTranscript: replaceEarlierCursor(
                previous.earlierTranscript,
                cursor.attemptId,
                page.earlierTranscript,
              ),
            }),
      );
    },
  });
  const run = detail.data?.run;
  const earlier = detail.data?.earlierTranscript.at(-1);
  const meters = poolMeters(detail.data?.transcript ?? []);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent
        side="right"
        aria-label="Run detail"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="border-b pr-14">
          <SheetTitle className="text-lg">{run?.loop ?? "Loading…"}</SheetTitle>
          {run !== undefined && (
            <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono wrap-anywhere">
              <span>{run.repository}</span>
              <span>{run.id}</span>
              {run.loopPaused && <Badge variant="outline">paused</Badge>}
            </SheetDescription>
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {detail.isError && <ErrorAlert className="m-6" message={detail.error.message} />}
          {run !== undefined && (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
                <StatusBadge state={run.state} />
                <span className="text-muted-foreground">{run.agent}</span>
                <span className="text-muted-foreground">
                  {run.attempts.length} attempt
                  {run.attempts.length === 1 ? "" : "s"}
                </span>
                {meters.map((meter) => (
                  <Badge
                    key={meter.pool}
                    variant="outline"
                    className="font-mono"
                    title="Share of the billing pool's rate-limit windows this session has used: 5-hour window, then weekly"
                  >
                    {meter.pool}
                    {meter.primaryUsedPercent !== null && ` ${meter.primaryUsedPercent}%`}
                    {meter.secondaryUsedPercent !== null && ` · ${meter.secondaryUsedPercent}%`}
                  </Badge>
                ))}
              </div>
              {run.state === "Queued" && (
                <p className="border-b px-6 py-3 text-muted-foreground">
                  Approved. Waiting for a free worker slot.
                </p>
              )}
              {(run.canApprove || run.canRetry || run.canCancel) && (
                <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
                  {run.canApprove && (
                    <Button
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate("approve")}
                    >
                      Approve
                    </Button>
                  )}
                  {run.canRetry && (
                    <Button
                      variant="secondary"
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate("retry")}
                    >
                      Retry
                    </Button>
                  )}
                  {run.canCancel && !confirmCancel && (
                    <Button
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={() => setConfirmCancel(true)}
                    >
                      Cancel
                    </Button>
                  )}
                  {run.canCancel && confirmCancel && (
                    <Button
                      variant="destructive"
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate("cancel")}
                    >
                      Confirm cancel
                    </Button>
                  )}
                </div>
              )}
              {mutation.isError && (
                <ErrorAlert className="mx-6 mt-4" message={mutation.error.message} />
              )}
              <Section title="Task">
                <Markdown className="max-w-prose">{run.task}</Markdown>
              </Section>
              <Section title="Event">
                <p className="font-mono text-muted-foreground wrap-anywhere">
                  {detail.data?.eventDedupKey}
                </p>
                <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted/50 px-2.5 py-2 font-mono text-[0.625rem]/relaxed whitespace-pre-wrap wrap-anywhere">
                  {jsonGist(detail.data?.eventPayload ?? null)}
                </pre>
              </Section>
              <Section title="Attempts">
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
                          {attempt.worker} · {brainLine(attempt.brain)} ·{" "}
                          {timeAgo(attempt.startedAt)}
                        </ItemDescription>
                        {attempt.outcome?._tag === "Failed" && (
                          <p className="text-destructive wrap-anywhere">
                            <strong>{attempt.outcome.failure._tag}</strong>
                            {` — ${failureMessage(attempt.outcome.failure)}`}
                          </p>
                        )}
                      </ItemContent>
                    </Item>
                  ))}
                </ItemGroup>
              </Section>
              {run.resultMessage !== null && (
                <Section title="Result">
                  <Markdown className="max-w-prose">{run.resultMessage}</Markdown>
                  {run.pullRequestUrl !== null && (
                    <Button
                      variant="link"
                      className="mt-2 px-0"
                      nativeButton={false}
                      render={<a href={run.pullRequestUrl} target="_blank" rel="noreferrer" />}
                    >
                      Open pull request
                      <ArrowSquareOutIcon data-icon="inline-end" aria-hidden="true" />
                    </Button>
                  )}
                </Section>
              )}
              <Section title="Transcript">
                {earlier !== undefined && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mb-3"
                    disabled={earlierMutation.isPending}
                    onClick={() => earlierMutation.mutate(earlier)}
                  >
                    {earlierMutation.isPending ? "Loading…" : "Load earlier"}
                  </Button>
                )}
                {earlierMutation.isError && (
                  <ErrorAlert className="mb-3" message={earlierMutation.error.message} />
                )}
                <Transcript events={detail.data?.transcript ?? []} />
              </Section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
