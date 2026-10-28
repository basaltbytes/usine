import { createFileRoute } from "@tanstack/react-router";
import { RunId } from "@usine/core/run";
import { runDetailQuery } from "~/lib/runs/queries";
import { RouteError, RoutePending } from "~/components/route-status";
import { RunPage } from "~/features/runs/run.page";

const RunRoute = () => {
  const { run } = Route.useParams();
  return <RunPage key={run} runId={run} />;
};

export const Route = createFileRoute("/projects/$owner/$name/runs/$run")({
  params: {
    parse: ({ run }) => ({ run: RunId.make(run) }),
    stringify: ({ run }) => ({ run }),
  },
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(runDetailQuery(context.queryClient, params.run)),
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  component: RunRoute,
});
