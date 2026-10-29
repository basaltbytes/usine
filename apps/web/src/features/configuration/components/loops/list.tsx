import type { ConfigurationView } from "@usine/orchestrator/operator";
import { ErrorAlert } from "~/components/error-alert";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { LoopRow } from "~/features/configuration/components/loops/row";
import { QuarantinedRow } from "~/features/configuration/components/loops/quarantined-row";
import { ConfigurationPage, Missing } from "~/features/configuration/components/section";
import { usePauseLoop } from "~/features/configuration/queries";
import { addLoop, loopCounts } from "~/features/configuration/strings";

export type PauseLoop = ReturnType<typeof usePauseLoop>;

type LoopsListProps = {
  readonly configuration: ConfigurationView;
  readonly pause: PauseLoop | null;
};

/** `pause` is `null` if operator actions are unavailable. */
export const LoopsList = ({ configuration, pause }: LoopsListProps) => (
  <ConfigurationPage title="Loops" createKind="loop" counts={loopCounts(configuration)}>
    {pause?.isError === true && <ErrorAlert message={pause.error.message} />}
    {configuration.loops.length === 0 && configuration.quarantinedLoops.length === 0 ? (
      <Missing title="No loops">{addLoop}</Missing>
    ) : (
      <div className="-mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="lg:w-56">Loop</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead className="hidden lg:table-cell">Condition</TableHead>
              <TableHead className="hidden sm:table-cell">Agent</TableHead>
              <TableHead className="hidden md:table-cell">Approval</TableHead>
              <TableHead>State</TableHead>
              <TableHead>
                <span className="sr-only">Action</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configuration.quarantinedLoops.map((loop) => (
              <QuarantinedRow key={loop.file} loop={loop} />
            ))}
            {configuration.loops.map((loop) => (
              <LoopRow
                key={loop.name}
                loop={loop}
                pause={pause}
                projects={configuration.projects}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </ConfigurationPage>
);
