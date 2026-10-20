import type { ReactNode } from "react";

/** A table row opened by one link stretched over it: hover and that link's keyboard focus fill the row. */
export const linkedRow =
  "relative hover:bg-muted/60 has-[a[data-row-link]:focus-visible]:bg-muted/60";

/**
 * The link that opens a `linkedRow`, marked with `data-row-link`; other controls in the row sit
 * above it with `relative z-10`.
 */
export const rowLink =
  "rounded-sm outline-none after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

/** A Task page section's title with how many entries it holds beside it. */
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

/** What an empty section would hold and how it fills. */
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
