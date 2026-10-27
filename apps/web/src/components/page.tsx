import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export const PageHeading = ({
  title,
  leading,
  counts,
  children,
  actions,
  className,
}: {
  readonly title: string;
  /** Content before the title, centred on its first line, such as a repository mark. */
  readonly leading?: ReactNode;
  /** The count text next to the title, for example `5 loops`. */
  readonly counts?: string | undefined;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) => (
  <header className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1", className)}>
    <h1 className="flex items-baseline gap-2 text-xl font-semibold wrap-anywhere">
      {leading !== undefined && (
        <span className="flex h-7 shrink-0 items-center self-start">{leading}</span>
      )}
      <span className="min-w-0">{title}</span>
    </h1>
    {counts !== undefined && <p className="text-sm text-muted-foreground tabular-nums">{counts}</p>}
    {children}
    {actions !== undefined && (
      <div className="ml-auto flex items-center gap-2 self-center">{actions}</div>
    )}
  </header>
);

/** The content width: `prose` is at most 768px; `full` fills the work panel. */
export type PageWidth = "prose" | "full";

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

const beside = {
  lg: "lg:flex-row lg:items-start lg:justify-between lg:gap-6",
  sm: "sm:flex-row sm:items-start sm:justify-between sm:gap-6",
  never: "",
} as const;

/**
 * Renders the header of a run or task: an optional 12px line above the heading, the heading, a
 * 13px facts line, and actions, beside the heading from `actionsBeside` and under it otherwise.
 */
export const PageHeader = ({
  eyebrow,
  heading,
  facts,
  actions,
  actionsBeside,
  className,
}: {
  readonly eyebrow?: ReactNode;
  readonly heading: ReactNode;
  readonly facts?: ReactNode;
  readonly actions?: ReactNode;
  readonly actionsBeside: keyof typeof beside;
  readonly className?: string;
}) => (
  <header className={cn("flex flex-col gap-3", beside[actionsBeside], className)}>
    <div className="min-w-0 space-y-1">
      {eyebrow !== undefined && (
        <p className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
          {eyebrow}
        </p>
      )}
      {heading}
      {facts !== undefined && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pt-0.5 text-sm text-muted-foreground">
          {facts}
        </div>
      )}
    </div>
    {actions !== undefined && <div className="shrink-0">{actions}</div>}
  </header>
);

/** Renders a fact after its Phosphor icon at text size, with `title` as tooltip, such as `Loop`. */
export const PageFact = ({
  icon: Glyph,
  title,
  children,
}: {
  readonly icon: Icon;
  readonly title?: string;
  readonly children: ReactNode;
}) => (
  <span className="inline-flex items-center gap-1.5" title={title}>
    <Glyph aria-hidden="true" className="size-[1em] shrink-0 text-faint" />
    {children}
  </span>
);
