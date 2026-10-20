import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A screen's title row: the heading, its counts beside it, then any marks, with the screen's
 * actions at the right. */
export const PageHeading = ({
  title,
  counts,
  children,
  actions,
  className,
}: {
  readonly title: string;
  /** What the screen holds, such as `5 loops`. */
  readonly counts?: string | undefined;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) => (
  <header className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1", className)}>
    <h1 className="text-xl font-semibold wrap-anywhere">{title}</h1>
    {counts !== undefined && <p className="text-sm text-muted-foreground tabular-nums">{counts}</p>}
    {children}
    {actions !== undefined && (
      <div className="ml-auto flex items-center gap-2 self-center">{actions}</div>
    )}
  </header>
);

/** How wide a screen's content runs: `prose` stops at 768px so lines stay readable, `full` fills
 * the work panel for tables and side-by-side layouts. */
export type PageWidth = "prose" | "full";

/** A screen in the work panel, as wide as `width` allows. */
export const Page = ({
  children,
  width = "prose",
}: {
  readonly children: ReactNode;
  readonly width?: PageWidth;
}) => (
  <main className="px-4 pt-5 pb-6 md:px-5">
    <div className={cn("flex flex-col gap-4", width === "prose" && "max-w-3xl")}>{children}</div>
  </main>
);
