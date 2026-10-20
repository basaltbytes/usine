import { createFileRoute, redirect } from "@tanstack/react-router";

/** The section opens on its first page. */
export const Route = createFileRoute("/configuration/")({
  beforeLoad: () => {
    throw redirect({ to: "/configuration/loops" });
  },
});
