import { createFileRoute } from "@tanstack/react-router";
import { RunId } from "@usine/core/run";
import { RunPage } from "../../../../../run-page/page.tsx";

const RunRoute = () => {
  const { runId } = Route.useParams();
  return <RunPage key={runId} runId={runId} />;
};

export const Route = createFileRoute("/projects/$owner/$name/runs/$runId")({
  params: {
    parse: ({ runId }) => ({ runId: RunId.make(runId) }),
    stringify: ({ runId }) => ({ runId }),
  },
  component: RunRoute,
});
