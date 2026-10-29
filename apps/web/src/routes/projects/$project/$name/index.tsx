import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$project/$name/")({
  loader: ({ location, context }) => {
    throw redirect({
      to: "/projects/$project",
      params: { project: context.legacyProject },
      search: location.search,
      replace: true,
    });
  },
});
