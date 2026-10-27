import { Link, useNavigate } from "@tanstack/react-router";
import type { LoopFileView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import { TableCell } from "~/components/ui/table";
import { LoopState } from "~/features/configuration/components/loops/state";
import { type PauseLoop } from "~/features/configuration/components/loops/list";
import { PauseButton } from "~/features/configuration/components/loops/pause-button";
import { OpeningRow, rowLinkClass } from "~/features/configuration/components/section";
import { approvalLabel } from "~/features/configuration/strings";
import { triggerLabel } from "~/lib/strings";

type LoopRowProps = {
  readonly loop: LoopFileView;
  readonly pause: PauseLoop | null;
};

export const LoopRow = ({ loop, pause }: LoopRowProps) => {
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
      <TableCell>{triggerLabel(loop.stream)}</TableCell>
      <FillCell className="hidden lg:table-cell">
        <code
          className="block truncate font-mono text-xs text-muted-foreground [font-variant-ligatures:none]"
          title={loop.condition}
        >
          {loop.condition}
        </code>
      </FillCell>
      <TableCell className="hidden sm:table-cell">{loop.agent}</TableCell>
      <TableCell className="hidden md:table-cell">{approvalLabel[loop.approval]}</TableCell>
      <TableCell>
        <LoopState paused={loop.paused} />
      </TableCell>
      <TableCell className="text-right">
        {pause !== null && <PauseButton loop={loop} pause={pause} variant="ghost" />}
      </TableCell>
    </OpeningRow>
  );
};
