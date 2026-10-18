import { ArrowClockwiseIcon, CheckCircleIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { LoopView } from "@usine/orchestrator/operator";
import { ErrorAlert } from "@/components/error-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "../../api.ts";
import { reloadSummary } from "../../operator-copy.ts";
import { overviewQuery } from "../../overview.ts";

const Loops = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  const queryClient = useQueryClient();
  const pauseMutation = useMutation({
    mutationFn: (loop: LoopView) =>
      api((client) => client[loop.paused ? "unpause" : "pause"]({ params: { loop: loop.name } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["overview"] }),
  });
  const reloadMutation = useMutation({
    mutationFn: () => api((client) => client.reload()),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
      ]),
  });
  const loops = data.loops;
  const pending = pauseMutation.isPending || data._tag === "NeedsSetup";
  return (
    <main className="flex flex-col gap-4 p-4 sm:p-6">
      <Card className="max-w-5xl">
        <CardHeader>
          <CardTitle>Loops</CardTitle>
          <CardDescription>
            {loops.length} loop{loops.length === 1 ? "" : "s"}
          </CardDescription>
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              disabled={reloadMutation.isPending}
              onClick={() => reloadMutation.mutate()}
            >
              <ArrowClockwiseIcon data-icon="inline-start" aria-hidden="true" />
              {reloadMutation.isPending ? "Reloading…" : "Reload configuration"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Loop</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loops.map((loop) => (
                <TableRow key={loop.name}>
                  <TableCell className="font-mono font-medium">{loop.name}</TableCell>
                  <TableCell className="font-mono">{loop.trigger}</TableCell>
                  <TableCell className="font-mono">{loop.agent}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{loop.paused ? "paused" : "active"}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant={loop.paused ? "default" : "outline"}
                      size="sm"
                      disabled={pending}
                      onClick={() => pauseMutation.mutate(loop)}
                    >
                      {loop.paused ? (
                        <PlayIcon data-icon="inline-start" aria-hidden="true" />
                      ) : (
                        <PauseIcon data-icon="inline-start" aria-hidden="true" />
                      )}
                      {loop.paused ? "Unpause" : "Pause"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {reloadMutation.isSuccess && (
        <Alert className="max-w-5xl">
          <CheckCircleIcon weight="fill" className="text-run-succeeded" />
          <AlertTitle>Configuration reloaded</AlertTitle>
          <AlertDescription>
            <ul>
              {reloadSummary(reloadMutation.data).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>New Runs use it; open Runs keep the Agent they were opened with.</p>
          </AlertDescription>
        </Alert>
      )}
      {reloadMutation.isError && (
        <ErrorAlert
          className="max-w-5xl"
          title="Configuration not reloaded"
          message={reloadMutation.error.message}
        />
      )}
      {pauseMutation.isError && (
        <ErrorAlert className="max-w-5xl" message={pauseMutation.error.message} />
      )}
    </main>
  );
};

export const Route = createFileRoute("/configuration/loops")({ component: Loops });
