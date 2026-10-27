import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

type ReaderLineProps = {
  readonly gutter?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string | undefined;
};

export const ReaderLine = ({ gutter, children, className }: ReaderLineProps) => (
  <div
    className={cn(
      "grid min-w-0 gap-x-6 gap-y-0.5 sm:grid-cols-[4.5rem_minmax(0,31.5rem)]",
      className,
    )}
  >
    {gutter === undefined ? (
      <div className="max-sm:hidden" />
    ) : (
      <div className="flex min-w-0 items-baseline gap-2 sm:flex-col sm:items-stretch sm:gap-0">
        {gutter}
      </div>
    )}
    <div className="min-w-0">{children}</div>
  </div>
);
