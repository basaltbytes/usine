import { createFileRoute } from "@tanstack/react-router";
import { Desk } from "~/features/overview/overview.page";
import { statisticsQuery } from "~/features/overview/queries";
import { deskQuery } from "~/lib/desk/queries";
import { RouteError, RoutePending } from "~/components/route-status";

export const Route = createFileRoute("/")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(deskQuery()),
      // Statistics failures remain visible in their section without hiding the overview.
      Promise.allSettled([queryClient.ensureQueryData(statisticsQuery("30d"))]),
    ]);
  },
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  component: Desk,
});
