import { Link } from "@tanstack/react-router";
import { ProjectScope, permits } from "@usine/core/access";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { LoopRow } from "~/features/configuration/components/loops/row";
import { QuarantinedRow } from "~/features/configuration/components/loops/quarantined-row";
import { ListEmpty } from "~/features/configuration/components/list-empty";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { usePauseLoop } from "~/features/configuration/queries";
import {
  emptyListCopy,
  loopCounts,
  noProjectForLoop,
  openProjects,
} from "~/features/configuration/strings";
import { usePermissions } from "~/lib/permissions";

export type PauseLoop = ReturnType<typeof usePauseLoop>;

type LoopsListProps = {
  readonly configuration: ConfigurationView;
  readonly pause: PauseLoop | null;
};

/** `pause` is `null` if operator actions are unavailable. */
export const LoopsList = ({ configuration, pause }: LoopsListProps) => {
  const grants = usePermissions();
  const empty = configuration.loops.length === 0 && configuration.quarantinedLoops.length === 0;
  const projectless = !configuration.projects.some(({ id }) =>
    permits(grants, "maintain", ProjectScope.make({ project: id })),
  );
  return (
    <ConfigurationPage
      title="Loops"
      createKind="loop"
      empty={empty}
      counts={loopCounts(configuration)}
    >
      {pause?.isError === true && <ErrorAlert message={pause.error.message} />}
      {empty ? (
        <ListEmpty
          title={emptyListCopy.loop.title}
          description={
            projectless
              ? `${emptyListCopy.loop.description} ${noProjectForLoop}`
              : emptyListCopy.loop.description
          }
          action={
            projectless ? (
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/configuration/projects" />}
              >
                {openProjects}
              </Button>
            ) : undefined
          }
        />
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
};
