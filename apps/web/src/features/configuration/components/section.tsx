import type { ReactNode } from "react";
import { Page, PageHeading } from "~/components/page";
import { StatusBadge } from "~/components/status-badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import type { ConfigurationEntityKey, ConfigurationEntityKind } from "@usine/config/configuration";
import { EntityEditor } from "~/features/configuration/components/editor/entity";
import { CreateEntity } from "~/features/configuration/components/editor/create";

type ConfigurationPageProps = {
  readonly title: string;
  readonly entity?: ConfigurationEntityKey;
  readonly createKind?: ConfigurationEntityKind;
  readonly leading?: ReactNode;
  readonly counts?: string;
  readonly marks?: ReactNode;
  readonly file?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
};

/** `file` is the export path shown on a detail page. */
export const ConfigurationPage = ({
  title,
  entity,
  createKind,
  leading,
  counts,
  marks,
  file,
  actions,
  children,
}: ConfigurationPageProps) => (
  <Page width="full">
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <PageHeading title={title} leading={leading} counts={counts}>
          {marks}
        </PageHeading>
        {file !== undefined && <p className="font-mono text-xs text-muted-foreground">{file}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
    {createKind !== undefined && <CreateEntity kind={createKind} />}
    {entity === undefined ? (
      children
    ) : (
      <EntityEditor key={entity.key} entity={entity}>
        {children}
      </EntityEditor>
    )}
  </Page>
);

type DetailColumnsProps = {
  readonly facts: ReactNode;
  readonly children: ReactNode;
};

/** On narrow screens, renders the facts rail before the main column. */
export const DetailColumns = ({ facts, children }: DetailColumnsProps) => (
  <div className="grid gap-x-10 gap-y-8 pt-2 lg:grid-cols-[minmax(0,1fr)_21rem]">
    <div className="flex min-w-0 flex-col gap-8 max-lg:order-2">{children}</div>
    <aside className="min-w-0 max-lg:order-1 lg:border-l lg:pl-6">{facts}</aside>
  </div>
);

type DetailSectionProps = {
  readonly title: string;
  /** A short note next to the title, for example a count. */
  readonly aside?: ReactNode;
  readonly children: ReactNode;
};

export const DetailSection = ({ title, aside, children }: DetailSectionProps) => (
  <section className="flex min-w-0 flex-col gap-3">
    <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-md font-semibold">{title}</h2>
      {aside !== undefined && <p className="text-xs text-muted-foreground">{aside}</p>}
    </header>
    {children}
  </section>
);

type FactsProps = { readonly children: ReactNode };

export const Facts = ({ children }: FactsProps) => (
  <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">{children}</dl>
);

type FactProps = {
  readonly label: string;
  readonly children: ReactNode;
};

export const Fact = ({ label, children }: FactProps) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 wrap-anywhere">{children}</dd>
  </>
);

type UnsetProps = { readonly children: ReactNode };

export const Unset = ({ children }: UnsetProps) => (
  <span className="text-muted-foreground">{children}</span>
);

type FrontmatterProps = {
  readonly entries: ReadonlyArray<readonly [string, string]>;
  readonly className?: string;
};

export const Frontmatter = ({ entries, className }: FrontmatterProps) => (
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

type OpeningRowProps = {
  readonly open: () => void;
  readonly children: ReactNode;
};

/** Renders a table row that opens a detail page on click; keyboard users use the link in its first cell. */
export const OpeningRow = ({ open, children }: OpeningRowProps) => (
  <TableRow
    className="cursor-pointer hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60"
    onClick={open}
  >
    {children}
  </TableRow>
);

/** Classes for the link in the first cell of an `OpeningRow`. */
export const rowLinkClass =
  "rounded-sm font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

export const NotLoaded = () => <StatusBadge state="Failed" label="Not loaded" />;

type MissingProps = {
  readonly title: string;
  readonly children: ReactNode;
};

/** Renders a detail page for a name that the loaded configuration does not contain. */
export const Missing = ({ title, children }: MissingProps) => (
  <Empty className="items-start p-0 py-6 text-left">
    <EmptyHeader className="items-start">
      <EmptyTitle className="text-md font-semibold tracking-normal">{title}</EmptyTitle>
      <EmptyDescription className="text-sm text-muted-foreground">{children}</EmptyDescription>
    </EmptyHeader>
  </Empty>
);
