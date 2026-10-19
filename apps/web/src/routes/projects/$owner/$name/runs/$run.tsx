import { createFileRoute } from "@tanstack/react-router";
import { RunId } from "@usine/core/run";
import { RunPage } from "../../../../../run-page/page.tsx";

const RunRoute = () => {
  const { run } = Route.useParams();
  return <RunPage key={run} runId={run} />;
};

export const Route = createFileRoute("/projects/$owner/$name/runs/$run")({
  params: {
    parse: ({ run }) => ({ run: RunId.make(run) }),
    stringify: ({ run }) => ({ run }),
  },
  component: RunRoute,
});
