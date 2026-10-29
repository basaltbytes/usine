import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$project/$name/tasks/$number")({
  loader: ({ params, location, context }) => {
    throw redirect({
      to: "/projects/$project/tasks/$number",
      params: { project: context.legacyProject, number: params.number },
      search: { ...location.search, repository: context.legacyRepository },
      replace: true,
    });
  },
});
