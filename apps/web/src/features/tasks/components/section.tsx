import type { ComponentProps, ReactNode } from "react";
import { TableRow } from "~/components/ui/table";

type LinkedRowProps = Readonly<ComponentProps<typeof TableRow>>;

/** Renders a table row covered by one link; hover and the link's keyboard focus highlight the row. */
export const LinkedRow = ({ className, ...props }: LinkedRowProps) => (
  <TableRow variant="linked" className={className} {...props} />
);

/** Classes for the link that covers a `LinkedRow`; give it `data-row-link`, and other controls in the row `relative z-10`. */
export const rowLink =
  "rounded-sm outline-none after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

type SectionHeadingProps = {
  readonly id: string;
  readonly title: string;
  readonly count: number;
};

export const SectionHeading = ({ id, title, count }: SectionHeadingProps) => (
  <h2 id={id} className="flex items-baseline gap-2">
    <span className="text-lg font-semibold">{title}</span>
    <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
  </h2>
);

type SectionEmptyProps = {
  readonly title: string;
  readonly children: ReactNode;
};

export const SectionEmpty = ({ title, children }: SectionEmptyProps) => (
  <div className="flex max-w-prose flex-col gap-1 border-t py-3">
    <p className="font-medium">{title}</p>
    <p className="text-muted-foreground">{children}</p>
  </div>
);
