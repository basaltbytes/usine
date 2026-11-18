import { Link, useNavigate } from "@tanstack/react-router";
import type { QuarantinedLoopView } from "@usine/orchestrator/operator";
import { TableCell } from "~/components/ui/table";
import { NotLoaded } from "~/features/configuration/components/section";
import { OpeningRow, rowLinkClass } from "~/components/opening-row";
import { TextTooltip } from "~/components/text-tooltip";

type QuarantinedRowProps = { readonly loop: QuarantinedLoopView };

export const QuarantinedRow = ({ loop }: QuarantinedRowProps) => {
  const navigate = useNavigate();
  const params = { loop: loop.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/loops/$loop", params })}>
      <TableCell size="roomy">
        <Link
          to="/configuration/loops/$loop"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {loop.name}
        </Link>
      </TableCell>
      <TableCell colSpan={5} className="max-w-0">
        <TextTooltip text={loop.error.message} repeats>
          <p className="truncate text-destructive">{loop.error.message}</p>
        </TextTooltip>
      </TableCell>
      <TableCell>
        <NotLoaded />
      </TableCell>
      <TableCell />
    </OpeningRow>
  );
};
