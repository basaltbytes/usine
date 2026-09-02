import { createFileRoute, redirect } from "@tanstack/react-router";

/** Configuration has one section today; the index forwards to it. */
export const Route = createFileRoute("/configuration/")({
  beforeLoad: () => {
    throw redirect({ to: "/configuration/loops" });
  },
});
