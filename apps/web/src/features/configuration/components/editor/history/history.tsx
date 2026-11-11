import { useCan } from "~/lib/permissions";
import { CaretRightIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  ConfigurationEntityKey,
  ConfigurationRevisionNumber,
} from "@usine/config/configuration";
import type { ConfigurationRevisionPage } from "@usine/orchestrator/operator/http";
import { format, isSameYear, isToday, isYesterday } from "date-fns";
import { DateTime } from "effect";
import { Fragment, useId, useState } from "react";
import { CodeBlock } from "~/components/ai-elements/code-block";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { configurationDiff } from "~/features/configuration/lib/diff";
import { entityHref } from "~/features/configuration/lib/entities";
import {
  configurationHeadQuery,
  revisionQuery,
  revisionsQuery,
  useConfigurationWrite,
} from "~/features/configuration/queries";
import { editorCopy, historyCopy } from "~/features/configuration/strings";
import { WriteFailure } from "~/features/configuration/components/editor/failure";

type RevisionDetailProps = {
  readonly number: ConfigurationRevisionNumber;
  readonly entity?: ConfigurationEntityKey | undefined;
};

const RevisionDetail = ({ number, entity }: RevisionDetailProps) => {
  const revision = useQuery(revisionQuery(number));
  const current = useQuery(configurationHeadQuery());
  const admin = useCan("admin");
  const maintain = useCan(
    "maintain",
    entity?.kind === "project"
      ? entity.identifier
      : entity?.kind === "loop"
        ? entity.identifier.split("/")[0]
        : undefined,
  );
  const canRevert =
    admin ||
    (maintain &&
      entity !== undefined &&
      revision.data?.entities.every((key) => key.key === entity.key));
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const write = useConfigurationWrite();
  return (
    <div className="flex min-w-0 flex-col items-start gap-3 pt-1 pb-5">
      {revision.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          {editorCopy.loading}
        </p>
      )}
      {revision.isError && <ErrorAlert message={revision.error.message} />}
      {revision.data?.changes
        .filter(({ key }) => entity === undefined || key.key === entity.key)
        .map((change) => (
          <CodeBlock
            key={change.key.key}
            className="w-full"
            code={
              configurationDiff(change.key.key, change.beforeText, change.afterText) ||
              editorCopy.noDiff
            }
            language="diff"
          />
        ))}
      {current.isError && <ErrorAlert message={current.error.message} />}
      {canRevert && revision.data !== undefined && !confirm && (
        <Button variant="outline" onClick={() => setConfirm(true)}>
          {editorCopy.revert}
        </Button>
      )}
      {confirm && (
        <form
          className="flex w-full max-w-xl flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (write.isPending || current.data === undefined) return;
            write.mutate(
              { action: "revert", number, payload: { expected: current.data.number, message } },
              { onSuccess: () => setConfirm(false) },
            );
          }}
        >
          <p>{editorCopy.revertWarning}</p>
          <ul className="font-mono text-xs text-muted-foreground">
            {revision.data?.entities.map((key) => (
              <li key={key.key}>{key.key}</li>
            ))}
          </ul>
          <Label className="flex flex-col items-start gap-2">
            {editorCopy.message}
            <Input value={message} onChange={(event) => setMessage(event.target.value)} />
          </Label>
          <div className="flex gap-2">
            <Button type="submit" disabled={write.isPending || current.data === undefined}>
              {write.isPending ? editorCopy.saving : editorCopy.confirmRevert}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={write.isPending}
              onClick={() => setConfirm(false)}
            >
              {editorCopy.cancel}
            </Button>
          </div>
        </form>
      )}
      {write.isError && <WriteFailure error={write.error} />}
      {write.isSuccess && (
        <p role="status" className="text-xs text-muted-foreground">
          {editorCopy.reverted}
        </p>
      )}
    </div>
  );
};

type ConfigurationRevisionSummaryView = ConfigurationRevisionPage["revisions"][number];

const dayLabel = (date: Date) =>
  isToday(date)
    ? historyCopy.today
    : isYesterday(date)
      ? historyCopy.yesterday
      : format(date, isSameYear(date, new Date()) ? "EEEE d MMMM" : "EEEE d MMMM yyyy");

const byDay = (revisions: readonly ConfigurationRevisionSummaryView[]) => {
  const days: Array<{ label: string; revisions: ConfigurationRevisionSummaryView[] }> = [];
  for (const revision of revisions) {
    const label = dayLabel(DateTime.toDateUtc(revision.time));
    const last = days.at(-1);
    if (last?.label === label) last.revisions.push(revision);
    else days.push({ label, revisions: [revision] });
  }
  return days;
};

type RevisionRowProps = {
  readonly revision: ConfigurationRevisionSummaryView;
  readonly entity?: ConfigurationEntityKey | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

const RevisionRow = ({ revision, entity, open, onOpenChange }: RevisionRowProps) => {
  const date = DateTime.toDateUtc(revision.time);
  const message = revision.message ?? "";
  const meta = useId();
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} render={<li className="min-w-0" />}>
      <div className="relative -mx-2 grid grid-cols-[3rem_minmax(0,1fr)_1rem] gap-x-3 rounded-md px-2 py-2.5 transition-colors duration-(--duration-fast) has-hover:hover:bg-muted/60 has-[button:focus-visible]:bg-muted/60">
        <time
          dateTime={DateTime.formatIso(revision.time)}
          title={date.toLocaleString()}
          className="font-mono text-xs leading-5 text-muted-foreground tabular-nums"
        >
          {format(date, "HH:mm")}
        </time>
        <div className="flex min-w-0 flex-col gap-0.5">
          <CollapsibleTrigger
            aria-describedby={meta}
            className={`text-left font-medium text-pretty wrap-anywhere outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-ring ${message === "" ? "text-muted-foreground" : ""}`}
          >
            {message === "" ? historyCopy.noMessage : message}
          </CollapsibleTrigger>
          <p
            id={meta}
            className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground"
          >
            <span>
              {historyCopy.revision}{" "}
              <span className="font-mono tabular-nums">{revision.number}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span>{revision.actor ?? editorCopy.localOperator}</span>
            {entity === undefined &&
              revision.entities.map((key) => (
                <Fragment key={key.key}>
                  <span aria-hidden="true">·</span>
                  <a
                    href={entityHref(key)}
                    className="relative min-w-0 rounded-sm font-mono text-primary wrap-anywhere underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {key.key}
                  </a>
                </Fragment>
              ))}
          </p>
        </div>
        <CaretRightIcon
          aria-hidden="true"
          className={`mt-0.5 size-4 text-muted-foreground transition-transform duration-(--duration-fast) ${open ? "rotate-90" : ""}`}
        />
      </div>
      <CollapsibleContent className="collapsible-motion sm:pl-15">
        <RevisionDetail number={revision.number} entity={entity} />
      </CollapsibleContent>
    </Collapsible>
  );
};

const openByDefault = 4;

type ConfigurationHistoryProps = { readonly entity?: ConfigurationEntityKey | undefined };

export const ConfigurationHistory = ({ entity }: ConfigurationHistoryProps) => {
  const history = useInfiniteQuery(revisionsQuery(entity));
  const [toggled, setToggled] = useState<ReadonlyMap<ConfigurationRevisionNumber, boolean>>(
    new Map(),
  );
  const revisions = history.data?.pages.flatMap((page) => page.revisions) ?? [];
  const latest = new Set(revisions.slice(0, openByDefault).map(({ number }) => number));
  return (
    <section className="flex min-w-0 flex-col gap-6" aria-label={editorCopy.history}>
      {history.isPending && (
        <p role="status" className="text-muted-foreground">
          {editorCopy.loading}
        </p>
      )}
      {history.isError && <ErrorAlert message={history.error.message} />}
      {history.isSuccess && revisions.length === 0 && (
        <p className="text-muted-foreground">{editorCopy.emptyHistory}</p>
      )}
      {byDay(revisions).map((day) => (
        <section key={day.label} aria-label={day.label} className="min-w-0">
          <h2 className="border-b pb-2 text-xs font-medium text-muted-foreground">{day.label}</h2>
          <ul className="flex min-w-0 flex-col pt-1">
            {day.revisions.map((revision) => (
              <RevisionRow
                key={revision.number}
                revision={revision}
                entity={entity}
                open={toggled.get(revision.number) ?? latest.has(revision.number)}
                onOpenChange={(open) =>
                  setToggled((previous) => new Map(previous).set(revision.number, open))
                }
              />
            ))}
          </ul>
        </section>
      ))}
      {history.hasNextPage && (
        <div>
          <Button
            variant="outline"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? editorCopy.loading : editorCopy.more}
          </Button>
        </div>
      )}
    </section>
  );
};
