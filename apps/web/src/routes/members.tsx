import { configurationQuery } from "~/lib/configuration/queries";
import { createFileRoute } from "@tanstack/react-router";
import { MembersPage } from "~/features/members/members.page";
import { membersQuery } from "~/lib/members/queries";
export const Route = createFileRoute("/members")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(membersQuery()),
      context.queryClient.ensureQueryData(configurationQuery()),
    ]),
  component: MembersPage,
});
