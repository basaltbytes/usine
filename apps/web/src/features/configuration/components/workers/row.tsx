import { PreflightAction } from "./action";
import { Link, useNavigate } from "@tanstack/react-router";
import type { WorkerConfigurationView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import { TableCell } from "~/components/ui/table";
import { PreflightState } from "~/features/configuration/components/workers/preflight";
import { OpeningRow, rowLinkClass } from "~/features/configuration/components/section";
import { SlotCells } from "~/features/configuration/components/workers/slots";
import { workerKindLabel, workerPlace } from "~/features/configuration/strings";
import { useNow } from "~/hooks/use-now";
import { creationFailureTitle, nextCreationLine } from "~/lib/workers/strings";

type WorkerRowProps = { readonly worker: WorkerConfigurationView };

export const WorkerRow = ({ worker }: WorkerRowProps) => {
  const now = useNow(15_000);
  const navigate = useNavigate();
  const params = { worker: worker.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/workers/$worker", params })}>
      <TableCell className="py-3">
        <Link
          to="/configuration/workers/$worker"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {worker.name}
        </Link>
      </TableCell>
      <TableCell>{workerKindLabel[worker.kind]}</TableCell>
      <TableCell className="hidden font-mono text-xs @2xl:table-cell">
        {workerPlace(worker)}
      </TableCell>
      <TableCell className="tabular-nums">
        {worker.slots === null ? (
          <span className="text-muted-foreground">{worker.maxConcurrentAttempts} max</span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <SlotCells slots={worker.slots} />
            <span className="max-sm:sr-only">
              {worker.slots.leased} of {worker.slots.capacity}
            </span>
          </span>
        )}
      </TableCell>
      <FillCell className="whitespace-normal">
        <PreflightState worker={worker} />
        <PreflightAction worker={worker} />
        {worker.provisioning?.blocked === true && (
          <p className="text-xs text-destructive tabular-nums" title={worker.provisioning.message}>
            {creationFailureTitle(worker.provisioning)}.{" "}
            {nextCreationLine(worker.provisioning, now)}
          </p>
        )}
      </FillCell>
    </OpeningRow>
  );
};
