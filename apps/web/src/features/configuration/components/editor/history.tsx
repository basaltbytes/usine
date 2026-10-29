import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  ConfigurationEntityKey,
  ConfigurationRevisionNumber,
} from "@usine/config/configuration";
import { DateTime } from "effect";
import { useState } from "react";
import { CodeBlock } from "~/components/ai-elements/code-block";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { configurationDiff } from "~/features/configuration/lib/diff";
import { entityHref, entityKey } from "~/features/configuration/lib/entities";
import {
  entityQuery,
  revisionQuery,
  revisionsQuery,
  useConfigurationWrite,
} from "~/features/configuration/queries";
import { editorCopy } from "~/features/configuration/strings";
import { WriteFailure } from "./failure";

type RevisionDetailProps = {
  readonly number: ConfigurationRevisionNumber;
  readonly entity?: ConfigurationEntityKey | undefined;
};

const RevisionDetail = ({ number, entity }: RevisionDetailProps) => {
  const revision = useQuery(revisionQuery(number));
  const current = useQuery(entityQuery(entityKey("settings", "instance")));
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const write = useConfigurationWrite();
  return (
    <div className="flex min-w-0 flex-col gap-3 pb-4">
      {revision.isPending && <p role="status">{editorCopy.loading}</p>}
      {revision.isError && <ErrorAlert message={revision.error.message} />}
      {revision.data?.changes
        .filter(({ key }) => entity === undefined || key.key === entity.key)
        .map((change) => (
          <div key={change.key.key} className="min-w-0 space-y-2">
            <a href={entityHref(change.key)} className="text-primary hover:underline">
              {change.key.key}
            </a>
            <CodeBlock
              code={
                configurationDiff(change.key.key, change.beforeText, change.afterText) ||
                editorCopy.noDiff
              }
              language="diff"
            />
          </div>
        ))}
      {current.isError && <ErrorAlert message={current.error.message} />}
      {revision.data !== undefined && (
        <div>
          <Button variant="outline" onClick={() => setConfirm(!confirm)}>
            {editorCopy.revert}
          </Button>
        </div>
      )}
      {confirm && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (current.data === undefined) return;
            write.mutate(
              { action: "revert", number, payload: { expected: current.data.number, message } },
              { onSuccess: () => setConfirm(false) },
            );
          }}
        >
          <p>{editorCopy.revertWarning}</p>
          <ul className="text-muted-foreground">
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
      {write.isSuccess && <p role="status">{editorCopy.reverted}</p>}
    </div>
  );
};

type ConfigurationHistoryProps = { readonly entity?: ConfigurationEntityKey | undefined };

export const ConfigurationHistory = ({ entity }: ConfigurationHistoryProps) => {
  const history = useInfiniteQuery(revisionsQuery(entity));
  const [selected, setSelected] = useState<ConfigurationRevisionNumber | null>(null);
  const revisions = history.data?.pages.flatMap((page) => page.revisions) ?? [];
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={editorCopy.history}>
      <h2 className="text-md font-semibold">{editorCopy.history}</h2>
      {history.isPending && <p role="status">{editorCopy.loading}</p>}
      {history.isError && <ErrorAlert message={history.error.message} />}
      {history.isSuccess && revisions.length === 0 && (
        <p className="text-muted-foreground">{editorCopy.emptyHistory}</p>
      )}
      <ul className="min-w-0 divide-y border-y">
        {revisions.map((revision) => (
          <li key={revision.number} className="min-w-0 py-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <Button
                variant="ghost"
                aria-expanded={selected === revision.number}
                onClick={() => setSelected(selected === revision.number ? null : revision.number)}
              >
                {editorCopy.revision(revision.number)}
              </Button>
              <span className="text-muted-foreground">
                {revision.actor ?? editorCopy.localOperator}
              </span>
              <time
                className="text-xs text-muted-foreground"
                dateTime={DateTime.formatIso(revision.time)}
              >
                {DateTime.toDateUtc(revision.time).toLocaleString()}
              </time>
              {revision.message !== null && (
                <span className="min-w-0 wrap-anywhere">{revision.message}</span>
              )}
            </div>
            {entity === undefined && (
              <ul className="flex flex-wrap gap-x-4 gap-y-1 py-2">
                {revision.entities.map((key) => (
                  <li key={key.key} className="min-w-0 wrap-anywhere">
                    <a className="text-primary hover:underline" href={entityHref(key)}>
                      {key.key}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {selected === revision.number && (
              <RevisionDetail number={revision.number} entity={entity} />
            )}
          </li>
        ))}
      </ul>
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
