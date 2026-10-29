import type { ReactNode } from "react";
import { Option } from "effect";
import { ItemMark } from "~/components/item/mark";
import { cardIdentity, taskCard, type TitledItem, useOverview } from "~/components/item/identity";
import { useNow } from "~/hooks/use-now";
import { agoLabel } from "~/lib/strings";
import type { NeedCopy } from "~/lib/needs-you/strings";

type NeedItemProps = {
  readonly copy: NeedCopy;
  readonly item?: TitledItem | undefined;
  readonly open?: (() => void) | undefined;
  readonly actions?: ReactNode;
  readonly dismiss?: ReactNode;
  readonly error?: string | null;
  readonly since?: string;
};

export const NeedItem = ({ copy, item, open, actions, dismiss, error, since }: NeedItemProps) => {
  const overview = useOverview();
  const now = useNow(15_000);
  const run = overview?.projects.flatMap(({ runs }) => runs).find(({ id }) => id === copy.runId);
  const subject =
    item ??
    Option.getOrUndefined(
      Option.map(
        run === undefined ? Option.none() : taskCard(overview, run.itemKey),
        (card) => cardIdentity(card).origin,
      ),
    );
  const at = since ?? run?.closedAt ?? run?.openedAt;
  return (
    <li className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 px-3 py-3 text-sm wrap-anywhere hover:bg-muted/40">
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        {open === undefined ? (
          <p className="font-medium">{copy.title}</p>
        ) : (
          <button
            type="button"
            onClick={open}
            className="rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            {copy.title}
          </button>
        )}
        {subject !== undefined && (
          <a
            href={subject.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-sm text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <ItemMark item={subject} linked={false} /> {subject.title}
          </a>
        )}
        {copy.detail !== subject?.title && (
          <p className="text-xs text-muted-foreground">{copy.detail}</p>
        )}
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          {copy.repository !== null && <span>{copy.repository}</span>}
          {at !== undefined && (
            <time dateTime={at} title={at} className="font-mono tabular-nums">
              {agoLabel(at, now)}
            </time>
          )}
        </div>
        {error !== undefined && error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {(actions !== undefined || dismiss !== undefined) && (
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
          {actions}
          {dismiss}
        </div>
      )}
    </li>
  );
};
