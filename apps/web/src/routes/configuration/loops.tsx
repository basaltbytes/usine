import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { LoopView } from "@usine/orchestrator/operator";
import { ErrorAlert } from "@/components/error-alert";
import { Page, PageHeading } from "@/components/page";
import {
  ReloadConfigurationButton,
  ReloadOutcome,
  useReloadConfiguration,
} from "@/components/reload-configuration";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "../../api.ts";
import { triggerLabel } from "../../operator-copy.ts";
import { overviewQuery } from "../../overview.ts";

const Loops = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  const queryClient = useQueryClient();
  const pauseMutation = useMutation({
    mutationFn: (loop: LoopView) =>
      api((client) => client[loop.paused ? "unpause" : "pause"]({ params: { loop: loop.name } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["overview"] }),
  });
  const reload = useReloadConfiguration();
  const loops = data.loops;
  const paused = loops.filter((loop) => loop.paused).length;
  const pending = pauseMutation.isPending || data._tag === "NeedsSetup";
  const sending = pauseMutation.isPending ? pauseMutation.variables.name : undefined;
  return (
    <Page>
      <PageHeading
        title="Loops"
        counts={`${loops.length} loop${loops.length === 1 ? "" : "s"}${paused > 0 ? `, ${paused} paused` : ""}`}
        actions={<ReloadConfigurationButton reload={reload} />}
      />
      <ReloadOutcome reload={reload} />
      {pauseMutation.isError && <ErrorAlert message={pauseMutation.error.message} />}
      <div className="-mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-full">Loop</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>State</TableHead>
              <TableHead>
                <span className="sr-only">Action</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loops.map((loop) => (
              <TableRow key={loop.name} className="hover:bg-transparent">
                <TableCell className="font-mono text-xs whitespace-normal wrap-anywhere">
                  {loop.name}
                </TableCell>
                <TableCell>{triggerLabel(loop.trigger)}</TableCell>
                <TableCell>{loop.agent}</TableCell>
                <TableCell>
                  <StatusBadge
                    state={loop.paused ? "paused" : "live"}
                    label={loop.paused ? "Paused" : "Active"}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    disabled={pending}
                    className="text-muted-foreground"
                    onClick={() => pauseMutation.mutate(loop)}
                  >
                    {loop.paused ? (
                      <PlayIcon data-icon="inline-start" aria-hidden="true" />
                    ) : (
                      <PauseIcon data-icon="inline-start" aria-hidden="true" />
                    )}
                    <span className="max-sm:sr-only">
                      {sending === loop.name
                        ? loop.paused
                          ? "Resuming…"
                          : "Pausing…"
                        : loop.paused
                          ? "Resume"
                          : "Pause"}
                    </span>
                    <span className="sr-only"> {loop.name}</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Page>
  );
};

export const Route = createFileRoute("/configuration/loops")({ component: Loops });
