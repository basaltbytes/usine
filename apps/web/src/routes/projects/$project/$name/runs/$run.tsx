import { RunId } from "@usine/core/run";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$project/$name/runs/$run")({
  loader: ({ params, location, context }) => {
    throw redirect({
      to: "/projects/$project/runs/$run",
      params: { project: context.legacyProject, run: RunId.make(params.run) },
      search: location.search,
      replace: true,
    });
  },
});
