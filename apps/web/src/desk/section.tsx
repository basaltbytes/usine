import { Link, useNavigate } from "@tanstack/react-router";
import type { BoardItemLink, RunView } from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { Option, Schema } from "effect";
import type { ReactNode } from "react";
import { TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { projectParams } from "../overview.ts";

/** One desk block: its title, an optional count beside it, an optional note at the right, then its body. */
export const DeskSection = ({
  id,
  title,
  count,
  countTone = "muted",
  note,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly count?: number | undefined;
  /** Needs you counts in its own tone, as the sidebar does. */
  readonly countTone?: "muted" | "needs-you";
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) => (
  <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
    <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "text-sm tabular-nums",
            countTone === "needs-you" ? "text-needs-you" : "text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
      {note !== undefined && (
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{note}</span>
      )}
    </header>
    {children}
  </section>
);

/** The sentence an empty desk block shows in place of its table. */
export const EmptyLine = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

const decodeItemKey = Schema.decodeUnknownOption(GitHubItemKey);

/** The Item's number in mono and its title, truncated to the cell; a Run without a known Item shows its id. */
export const ItemTitle = ({
  item,
  run,
}: {
  readonly item: BoardItemLink | null;
  readonly run?: Pick<RunView, "id" | "itemKey"> | undefined;
}) => {
  const number =
    item?.number ??
    Option.getOrUndefined(
      Option.map(
        Option.flatMap(Option.fromNullishOr(run), ({ itemKey }) => decodeItemKey(itemKey)),
        ([, , value]) => value,
      ),
    );
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {number === undefined ? `Run ${run?.id.slice(0, 8) ?? ""}` : `#${number}`}
      </span>
      <span className="truncate font-medium" title={item?.title}>
        {item?.title ?? ""}
      </span>
    </span>
  );
};

/** Links the Run page of `run`; the row around it opens the same page on a click anywhere. */
export const RunPageLink = ({
  run,
  children,
}: {
  readonly run: Pick<RunView, "id" | "repository">;
  readonly children: ReactNode;
}) => (
  <Link
    to="/projects/$owner/$name/runs/$run"
    params={{ ...projectParams(run.repository), run: run.id }}
    onClick={(event) => event.stopPropagation()}
    className="block min-w-0 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid"
  >
    {children}
  </Link>
);

/** A table row that opens the Run page of `run`, or a row that opens nothing when there is no Run. */
export const RunRow = ({
  run,
  className,
  children,
}: {
  readonly run: Pick<RunView, "id" | "repository"> | null;
  readonly className?: string;
  readonly children: ReactNode;
}) => {
  const navigate = useNavigate();
  return (
    <TableRow
      className={cn(
        run === null
          ? "hover:bg-transparent"
          : "cursor-pointer hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60",
        className,
      )}
      onClick={
        run === null
          ? undefined
          : () =>
              void navigate({
                to: "/projects/$owner/$name/runs/$run",
                params: { ...projectParams(run.repository), run: run.id },
              })
      }
    >
      {children}
    </TableRow>
  );
};
