import { Link, useNavigate } from "@tanstack/react-router";
import type { RunView } from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { projectParams } from "~/lib/overview";

type DeskSectionProps = {
  readonly id: string;
  readonly title: string;
  readonly count?: number | undefined;
  /** `needs-you` uses the Needs you tone, as in the sidebar. */
  readonly countTone?: "muted" | "needs-you";
  readonly note?: ReactNode;
  /** Controls at the end of the header, after the note. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
};

export const DeskSection = ({
  id,
  title,
  count,
  countTone = "muted",
  note,
  actions,
  children,
}: DeskSectionProps) => (
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
      {actions !== undefined && (
        <div className={cn("self-center", note === undefined && "ml-auto")}>{actions}</div>
      )}
    </header>
    {children}
  </section>
);

type EmptyLineProps = { readonly children: ReactNode };

export const EmptyLine = ({ children }: EmptyLineProps) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

type RunPageLinkProps = {
  readonly run: Pick<RunView, "id" | "repository">;
  readonly children: ReactNode;
};

/** Renders a link to the Run page of `run`; the enclosing row opens the same page on click. */
export const RunPageLink = ({ run, children }: RunPageLinkProps) => (
  <Link
    to="/projects/$project/$name/runs/$run"
    params={{ ...projectParams(run.repository), run: run.id }}
    onClick={(event) => event.stopPropagation()}
    className="block min-w-0 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid"
  >
    {children}
  </Link>
);

type RunRowProps = {
  readonly run: Pick<RunView, "id" | "repository"> | null;
  readonly className?: string;
  readonly children: ReactNode;
};

/**
 * Renders a table row that opens the Run page of `run` on a click outside its links and buttons; if
 * `run` is `null`, the row is not clickable.
 */
export const RunRow = ({ run, className, children }: RunRowProps) => {
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
          : (event) => {
              if (event.target instanceof Element && event.target.closest("a, button") !== null)
                return;
              void navigate({
                to: "/projects/$project/$name/runs/$run",
                params: { ...projectParams(run.repository), run: run.id },
              });
            }
      }
    >
      {children}
    </TableRow>
  );
};
