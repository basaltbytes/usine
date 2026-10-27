import { Link, useNavigate } from "@tanstack/react-router";
import type { QuarantinedLoopView } from "@usine/orchestrator/operator";
import { TableCell } from "~/components/ui/table";
import { NotLoaded, OpeningRow, rowLinkClass } from "~/features/configuration/components/section";

type QuarantinedRowProps = { readonly loop: QuarantinedLoopView };

export const QuarantinedRow = ({ loop }: QuarantinedRowProps) => {
  const navigate = useNavigate();
  const params = { loop: loop.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/loops/$loop", params })}>
      <TableCell className="py-3">
        <Link
          to="/configuration/loops/$loop"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {loop.name}
        </Link>
      </TableCell>
      <TableCell colSpan={4} className="max-w-0">
        <p className="truncate text-destructive" title={loop.error.message}>
          {loop.error.message}
        </p>
      </TableCell>
      <TableCell>
        <NotLoaded />
      </TableCell>
      <TableCell />
    </OpeningRow>
  );
};
