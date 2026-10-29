import { createFileRoute } from "@tanstack/react-router";
import { MembersPage } from "~/features/members/members.page";
import { membersQuery } from "~/features/members/queries";
export const Route = createFileRoute("/members")({
  loader: ({ context }) => context.queryClient.ensureQueryData(membersQuery()),
  component: MembersPage,
});
