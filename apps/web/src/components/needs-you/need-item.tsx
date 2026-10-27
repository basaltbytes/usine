import { CaretRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { ItemMark, type ItemRef } from "~/components/item/mark";
import { cn } from "~/lib/utils";
import type { NeedCopy } from "~/lib/needs-you/strings";

type NeedItemProps = {
  readonly copy: Pick<NeedCopy, "title" | "detail" | "repository">;
  /** The item the entry is about, marked before the detail; linked only if `open` is absent. */
  readonly item?: ItemRef | undefined;
  readonly open?: (() => void) | undefined;
  readonly actions?: ReactNode;
  /** The error message of the last failed action on this entry. */
  readonly error?: string | null;
  readonly fullDetail?: boolean;
  readonly compact?: boolean;
};

/** `open` makes the whole entry clickable, for example to open the Run drawer. `fullDetail` wraps the detail
 * and puts the actions below it. `compact` keeps the entry on one line, with the detail truncated
 * and the full text in a tooltip. */
export const NeedItem = ({
  copy,
  item,
  open,
  actions,
  error,
  fullDetail = false,
  compact = false,
}: NeedItemProps) => {
  const wraps = fullDetail && !compact;
  // A compact entry never truncates the title: below sm the detail wraps to two lines under it;
  // from sm the detail is truncated beside the title.
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
      {item !== undefined && (
        <>
          <ItemMark item={item} linked={open === undefined} />{" "}
        </>
      )}
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
        "relative flex min-w-0 flex-wrap items-center gap-x-3 rounded-lg border border-needs-you/25 bg-needs-you/5 transition-colors duration-(--duration-fast) ease-out-expo motion-safe:animate-in motion-safe:fade-in has-[[data-need-open]:hover]:bg-needs-you/8",
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
