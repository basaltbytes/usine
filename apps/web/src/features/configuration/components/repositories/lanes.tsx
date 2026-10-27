import type { RepositoryConfigurationView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { SourceChip } from "~/features/configuration/components/repositories/source-chip";

type LanesTableProps = { readonly repository: RepositoryConfigurationView };

export const LanesTable = ({ repository }: LanesTableProps) => (
  <div className="-mx-2">
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-right">#</TableHead>
          <TableHead>Lane</TableHead>
          <TableHead>Items with</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {repository.lanes.map((lane, index) => (
          <TableRow key={lane.name} className="hover:bg-transparent">
            <TableCell className="py-3 text-right align-top font-mono text-xs text-muted-foreground tabular-nums">
              {index + 1}
            </TableCell>
            <TableCell className="py-3 align-top font-medium">{lane.name}</TableCell>
            <FillCell className="py-3 whitespace-normal">
              <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {lane.sources.map((source) => (
                  <li key={source._tag === "Label" ? source.label.name : source.state}>
                    <SourceChip source={source} />
                  </li>
                ))}
              </ul>
            </FillCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);
