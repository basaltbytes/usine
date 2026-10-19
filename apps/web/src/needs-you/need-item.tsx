import { CaretRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { NeedCopy } from "../operator-copy.ts";

/** One Needs you entry: its title, the Project it concerns, and one line of detail, with its actions
 * on the right. `open` makes the whole entry open what it is about, such as the Run drawer. */
export const NeedItem = ({
  copy,
  open,
  actions,
  error,
}: {
  readonly copy: Pick<NeedCopy, "title" | "detail" | "repository">;
  readonly open?: (() => void) | undefined;
  readonly actions?: ReactNode;
  /** Why the last action on this entry failed. */
  readonly error?: string | null;
}) => {
  const text = (
    <>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-sm font-medium text-foreground">{copy.title}</span>
        {copy.repository !== null && (
          <span className="shrink-0 text-xs text-foreground/70">{copy.repository}</span>
        )}
      </span>
      <span className="block truncate text-xs text-foreground/75" title={copy.detail}>
        {copy.detail}
      </span>
    </>
  );
  return (
    <li className="relative flex min-h-14 min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-needs-you/25 bg-needs-you/5 px-3.5 py-2.5 transition-colors has-[[data-need-open]:hover]:bg-needs-you/8">
      <div className="flex min-w-56 flex-1 flex-col gap-0.5">
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
