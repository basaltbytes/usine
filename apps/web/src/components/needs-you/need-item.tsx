import type { LoopName } from "@usine/core/loop";
import { DotsThreeIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Option } from "effect";
import { ItemHeading } from "~/components/item/heading";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cardIdentity, taskCard, type TitledItem, useOverview } from "~/components/item/identity";
import { useNow } from "~/hooks/use-now";
import { agoLabel } from "~/lib/strings";
import {
  type NeedCopy,
  needDetailsLabel,
  needOpenRunLabel,
  needActionsLabel,
} from "~/lib/needs-you/strings";

type NeedItemProps = {
  readonly copy: NeedCopy;
  readonly item?: TitledItem | undefined;
  readonly open?: (() => void) | undefined;
  readonly actions?: ReactNode;
  readonly dismiss?: ReactNode;
  readonly menu?: ReactNode;
  readonly heading?: string;
  readonly loop?: LoopName | undefined;
  readonly error?: string | null;
  readonly since?: string;
};

export const NeedItem = ({
  copy,
  item,
  open,
  actions,
  dismiss,
  menu,
  heading,
  loop,
  error,
  since,
}: NeedItemProps) => {
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
  const title = subject?.title ?? heading ?? copy.detail;
  const context = [loop ?? run?.loop, copy.repository].filter((part) => part != null).join(" · ");
  return (
    <li className="min-w-0 px-3 py-1.5 text-sm hover:bg-muted/40">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1" title={`${copy.title}: ${copy.detail}`}>
          {subject === undefined ? (
            <p className="truncate font-medium">{title}</p>
          ) : (
            <a
              href={subject.url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70"
            >
              <ItemHeading
                item={Option.some(subject)}
                title={subject.title}
                variant="row"
                linked={false}
              />
            </a>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions ??
            (open !== undefined && (
              <Button variant="ghost" onClick={open}>
                {needDetailsLabel}
              </Button>
            ))}
          {(dismiss !== undefined ||
            menu !== undefined ||
            (open !== undefined && actions !== undefined)) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" aria-label={needActionsLabel(title)} />}
              >
                <DotsThreeIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max max-w-80">
                {open !== undefined && actions !== undefined && (
                  <DropdownMenuItem onClick={open}>{needOpenRunLabel}</DropdownMenuItem>
                )}
                {menu}
                {dismiss}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      <p className="truncate text-xs text-muted-foreground" title={copy.detail}>
        {context || (title === copy.detail ? null : copy.detail)}
        {at !== undefined && (
          <>
            {" · "}
            <time dateTime={at} title={at} className="font-mono tabular-nums">
              {agoLabel(at, now)}
            </time>
          </>
        )}
      </p>
      {error !== undefined && error !== null && (
        <p role="alert" className="text-xs text-destructive wrap-anywhere">
          {error}
        </p>
      )}
    </li>
  );
};
