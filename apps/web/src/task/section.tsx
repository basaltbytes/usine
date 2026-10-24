import type { ReactNode } from "react";

/** Classes for a table row covered by one link; hover and the link's keyboard focus highlight the row. */
export const linkedRow =
  "relative hover:bg-muted/60 has-[a[data-row-link]:focus-visible]:bg-muted/60";

/** Classes for the link that covers a `linkedRow`; give it `data-row-link`, and other controls in the row `relative z-10`. */
export const rowLink =
  "rounded-sm outline-none after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

export const SectionHeading = ({
  id,
  title,
  count,
}: {
  readonly id: string;
  readonly title: string;
  readonly count: number;
}) => (
  <h2 id={id} className="flex items-baseline gap-2">
    <span className="text-lg font-semibold">{title}</span>
    <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
  </h2>
);

export const SectionEmpty = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <div className="flex max-w-prose flex-col gap-1 border-t py-3">
    <p className="font-medium">{title}</p>
    <p className="text-muted-foreground">{children}</p>
  </div>
);
