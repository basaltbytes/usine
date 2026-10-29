import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$project/$name/tasks/")({
  loader: ({ location, context }) => {
    throw redirect({
      to: "/projects/$project/tasks",
      params: { project: context.legacyProject },
      search: { ...location.search, repository: context.legacyRepository },
      replace: true,
    });
  },
});
