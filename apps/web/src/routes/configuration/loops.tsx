import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { LoopView } from "@usine/orchestrator";
import { ErrorAlert } from "@/components/error-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiOk, api } from "../../api.ts";
import { overviewQuery } from "../../overview.ts";

const Loops = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  const queryClient = useQueryClient();
  const pauseMutation = useMutation({
    mutationFn: (loop: LoopView) =>
      api(
        `/api/loops/${encodeURIComponent(loop.name)}/${loop.paused ? "unpause" : "pause"}`,
        ApiOk,
        { method: "POST" },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["overview"] }),
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
      {pauseMutation.isError && (
        <ErrorAlert className="max-w-5xl" message={pauseMutation.error.message} />
      )}
    </main>
  );
};

export const Route = createFileRoute("/configuration/loops")({ component: Loops });
