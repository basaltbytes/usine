import type { ReactNode } from "react";
import { TableRow } from "~/components/ui/table";

type OpeningRowProps = {
  readonly open: () => void;
  readonly children: ReactNode;
};

/** Renders a table row that opens something on click; keyboard users use the link in its first cell. */
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
