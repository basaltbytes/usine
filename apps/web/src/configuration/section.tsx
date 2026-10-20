import type { ReactNode } from "react";
import { Page, PageHeading } from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { SectionReloadButton, SectionReloadResult } from "./reload.tsx";

/** A Configuration page: full width, its heading with the section's Reload configuration action,
 * then the result of the last reload. `file` names the authored file a detail page shows. */
export const ConfigurationPage = ({
  title,
  counts,
  marks,
  file,
  actions,
  children,
}: {
  readonly title: string;
  readonly counts?: string;
  readonly marks?: ReactNode;
  readonly file?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) => (
  <Page width="full">
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <PageHeading title={title} counts={counts}>
          {marks}
        </PageHeading>
        {file !== undefined && <p className="font-mono text-xs text-muted-foreground">{file}</p>}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <SectionReloadButton />
      </div>
    </div>
    <SectionReloadResult />
    {children}
  </Page>
);

/** A detail page's body: what the file says at length beside a rail of its short facts, the rail
 * first on narrow screens. */
export const DetailColumns = ({
  facts,
  children,
}: {
  readonly facts: ReactNode;
  readonly children: ReactNode;
}) => (
  <div className="grid gap-x-10 gap-y-8 pt-2 lg:grid-cols-[minmax(0,1fr)_21rem]">
    <div className="flex min-w-0 flex-col gap-8 max-lg:order-2">{children}</div>
    <aside className="min-w-0 max-lg:order-1 lg:border-l lg:pl-6">{facts}</aside>
  </div>
);

/** One titled part of a detail page's main column. */
export const DetailSection = ({
  title,
  aside,
  children,
}: {
  readonly title: string;
  /** A short note beside the title, such as a count. */
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) => (
  <section className="flex min-w-0 flex-col gap-3">
    <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-md font-semibold">{title}</h2>
      {aside !== undefined && <p className="text-xs text-muted-foreground">{aside}</p>}
    </header>
    {children}
  </section>
);

/** A definition list of short facts, label beside value. */
export const Facts = ({ children }: { readonly children: ReactNode }) => (
  <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">{children}</dl>
);

export const Fact = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 wrap-anywhere">{children}</dd>
  </>
);

/** Text that is absent from the file, such as `Not set`, in the muted tone. */
export const Unset = ({ children }: { readonly children: ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
);

/** Keys and values copied from a file's frontmatter, in mono, keys muted. */
export const Frontmatter = ({
  entries,
  className,
}: {
  readonly entries: ReadonlyArray<readonly [string, string]>;
  readonly className?: string;
}) => (
  <dl
    className={cn(
      "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg bg-card px-3 py-2.5 font-mono text-xs [font-variant-ligatures:none] ring-1 ring-border",
      className,
    )}
  >
    {entries.map(([key, value]) => (
      <div key={key} className="contents">
        <dt className="text-muted-foreground">{key}:</dt>
        <dd className="whitespace-pre-wrap text-foreground wrap-anywhere">{value}</dd>
      </div>
    ))}
  </dl>
);

/** A table row that opens a detail page; its first cell holds the link that keyboard users reach. */
export const OpeningRow = ({
  open,
  children,
}: {
  readonly open: () => void;
  readonly children: ReactNode;
}) => (
  <TableRow
    className="cursor-pointer hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60"
    onClick={open}
  >
    {children}
  </TableRow>
);

/** The link in an opening row's first cell. */
export const rowLinkClass =
  "rounded-sm font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

/** A file that did not load: the word in red beside its dot. */
export const NotLoaded = () => <StatusBadge state="Failed" label="Not loaded" />;

/** A detail page whose name the loaded configuration does not have. */
export const Missing = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <Empty className="items-start p-0 py-6 text-left">
    <EmptyHeader className="items-start">
      <EmptyTitle className="text-md font-semibold tracking-normal">{title}</EmptyTitle>
      <EmptyDescription className="text-sm text-muted-foreground">{children}</EmptyDescription>
    </EmptyHeader>
  </Empty>
);
