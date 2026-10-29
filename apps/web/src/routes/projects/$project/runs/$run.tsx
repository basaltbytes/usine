import { overviewQuery, projectId, projectForRepository } from "~/lib/overview";
import { ProjectNotFound } from "~/components/project-not-found";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { RunId } from "@usine/core/run";
import { runDetailQuery } from "~/lib/runs/queries";
import { RouteError, RoutePending } from "~/components/route-status";
import { RunPage } from "~/features/runs/run.page";

const RunRoute = () => {
  const { run } = Route.useParams();
  return <RunPage key={run} runId={run} />;
};

export const Route = createFileRoute("/projects/$project/runs/$run")({
  params: {
    parse: ({ run }) => ({ run: RunId.make(run) }),
    stringify: ({ run }) => ({ run }),
  },
  loader: async ({ context, params }) => {
    const [overview, detail] = await Promise.all([
      context.queryClient.ensureQueryData(overviewQuery()),
      context.queryClient.ensureQueryData(runDetailQuery(context.queryClient, params.run)),
    ]);
    const project = projectForRepository(overview.projects, detail.run.repository);
    if (project === undefined || projectId(project) !== params.project) throw notFound();
    return detail;
  },
  notFoundComponent: ProjectNotFound,
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  component: RunRoute,
});
