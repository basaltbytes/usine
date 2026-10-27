import type { ComponentProps } from "react";
import { TableCell } from "~/components/ui/table";
import { cn } from "~/lib/utils";

type FillCellProps = Readonly<ComponentProps<typeof TableCell>>;

/**
 * Renders a cell of the column that takes a table's remaining width. Its content never widens the
 * table: wrap it with `whitespace-normal` or cut it short with `truncate`.
 *
 * Every other column of the table is as narrow as its content allows. Content there that can wrap,
 * such as a sentence or a `flex-wrap` row, wraps at its longest word or item unless its cell has a
 * minimum width.
 */
export const FillCell = ({ className, ...props }: FillCellProps) => (
  <TableCell className={cn("w-full max-w-0", className)} {...props} />
);
