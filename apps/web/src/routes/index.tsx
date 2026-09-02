import { ArrowRightIcon } from "@phosphor-icons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { NeedsYouBadge, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { overviewQuery, projectParams } from "../overview.ts";

const ProjectIndex = () => {
  const { data } = useSuspenseQuery(overviewQuery());
  const navigate = useNavigate();
  const projects = data.projects;
  return (
    <main className="flex flex-col gap-4 p-4 sm:p-6">
      <Card className="max-w-5xl">
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>
            {projects.length} registered repositor{projects.length === 1 ? "y" : "ies"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No project registered</EmptyTitle>
                <EmptyDescription>
                  Add a repository under <code>repos</code> in <code>usine.yaml</code> and restart{" "}
                  <code>usine up</code>.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Lanes</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => {
                  const params = projectParams(project.repository);
                  const itemCount = project.board.lanes.reduce(
                    (total, lane) => total + lane.items.length,
                    0,
                  );
                  const needsYou = project.board.lanes.reduce(
                    (total, lane) => total + lane.items.filter((item) => item.needsYou).length,
                    0,
                  );
                  return (
                    <TableRow
                      key={project.repository}
                      className="cursor-pointer"
                      onClick={() => void navigate({ to: "/projects/$owner/$name", params })}
                    >
                      <TableCell className="font-mono font-medium">{project.repository}</TableCell>
                      <TableCell className="text-right tabular-nums">{itemCount}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {project.board.lanes.length}
                      </TableCell>
                      <TableCell>
                        {project.status === "needs-you" ? (
                          <NeedsYouBadge count={needsYou} />
                        ) : (
                          <StatusBadge state={project.status} />
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Open ${project.repository}`}
                          nativeButton={false}
                          render={
                            <Link
                              to="/projects/$owner/$name"
                              params={params}
                              onClick={(event) => event.stopPropagation()}
                            />
                          }
                        >
                          <ArrowRightIcon aria-hidden="true" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/")({ component: ProjectIndex });
