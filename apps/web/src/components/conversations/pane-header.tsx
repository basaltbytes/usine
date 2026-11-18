import { CaretLeftIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { backToListLabel } from "~/lib/conversations/strings";

type PaneHeaderProps = {
  readonly title: string;
  /** Returns to the list; the control shows only while the list and the pane share one column. */
  readonly back: () => void;
  readonly children?: ReactNode;
  readonly "aria-busy"?: boolean;
};

/** The head of the inbox's open pane: a back control on narrow screens, the title, and facts. */
export const PaneHeader = ({ title, back, children, "aria-busy": busy }: PaneHeaderProps) => (
  <header
    aria-busy={busy}
    className="flex min-h-16 shrink-0 items-start gap-2 border-b px-5 py-3.5 pr-(--inbox-controls,1.25rem)"
  >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={backToListLabel}
      data-pane-back=""
      className="-ml-2 shrink-0 pointer-coarse:size-11 @3xl/inbox:hidden"
      onClick={back}
    >
      <CaretLeftIcon />
    </Button>
    <div className="min-w-0 flex-1 space-y-1.5">
      <h2 className="text-lg/snug font-semibold text-balance wrap-anywhere">{title}</h2>
      {children}
    </div>
  </header>
);
