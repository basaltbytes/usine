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

/** A list screen in the work panel, bounded in width so a row stays readable. */
export const Page = ({ children }: { readonly children: ReactNode }) => (
  <main className="px-4 pt-5 pb-6 md:px-5">
    <div className="flex max-w-3xl flex-col gap-4">{children}</div>
  </main>
);
