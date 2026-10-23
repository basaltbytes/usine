import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/configuration/")({
  beforeLoad: () => {
    throw redirect({ to: "/configuration/loops" });
  },
});
