import { CaretRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { NeedCopy } from "../operator-copy.ts";

/** One Needs you entry: its title, the Project it concerns, and one line of detail, with its actions
 * on the right. `open` makes the whole entry open what it is about, such as the Run drawer.
 * `fullDetail` lets the detail wrap, with the actions below it, for a recovery that must read in full.
 * `compact` keeps the entry to one line, its detail truncated with the full text in its tooltip. */
export const NeedItem = ({
  copy,
  open,
  actions,
  error,
  fullDetail = false,
  compact = false,
}: {
  readonly copy: Pick<NeedCopy, "title" | "detail" | "repository">;
  readonly open?: (() => void) | undefined;
  readonly actions?: ReactNode;
  /** Why the last action on this entry failed. */
  readonly error?: string | null;
  readonly fullDetail?: boolean;
  readonly compact?: boolean;
}) => {
  const wraps = fullDetail && !compact;
  // A compact entry keeps its title whole: below sm the detail wraps to two lines under it,
  // from sm the entry is one line with the detail shortened beside the title.
  const title = (
    <span
      className={cn(
        "text-sm font-medium text-foreground",
        compact ? "sm:shrink-0 sm:whitespace-nowrap" : "truncate",
      )}
    >
      {copy.title}
    </span>
  );
  const detail = (
    <span
      className={cn(
        "text-xs text-foreground/75",
        compact
          ? "min-w-0 line-clamp-2 sm:block sm:flex-1 sm:text-ellipsis sm:whitespace-nowrap"
          : "block",
        !wraps && !compact && "truncate",
      )}
      title={wraps ? undefined : copy.detail}
    >
      {copy.detail}
    </span>
  );
  const text = compact ? (
    <span className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      {title}
      {detail}
    </span>
  ) : (
    <>
      <span className="flex min-w-0 items-baseline gap-2">
        {title}
        {copy.repository !== null && (
          <span className="shrink-0 text-xs text-foreground/70">{copy.repository}</span>
        )}
      </span>
      {detail}
    </>
  );
  return (
    <li
      className={cn(
        "relative flex min-w-0 flex-wrap items-center gap-x-3 rounded-lg border border-needs-you/25 bg-needs-you/5 transition-colors has-[[data-need-open]:hover]:bg-needs-you/8",
        compact ? "gap-y-1 px-3 py-1" : "min-h-14 gap-y-2 px-3.5 py-2.5",
      )}
    >
      <div
        className={cn(
          "flex flex-1 flex-col gap-0.5",
          compact ? "min-w-0" : "min-w-56",
          wraps && "basis-full",
        )}
      >
        {open === undefined ? (
          text
        ) : (
          <button
            type="button"
            data-need-open=""
            onClick={open}
            className="flex min-w-0 flex-col gap-0.5 text-left outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring/70"
          >
            {text}
          </button>
        )}
        {error !== undefined && error !== null && (
          <p className="text-xs text-destructive wrap-anywhere">{error}</p>
        )}
      </div>
      {actions !== undefined ? (
        <div className="relative z-10 ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {actions}
        </div>
      ) : (
        open !== undefined && (
          <CaretRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-needs-you/70" />
        )
      )}
    </li>
  );
};
