import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { BindingsList } from "~/features/configuration/components/bindings/list";
import { configurationQuery } from "~/lib/configuration/queries";
import { membersQuery } from "~/lib/members/queries";

const Bindings = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  const { data: members } = useSuspenseQuery(membersQuery());
  const { member } = Route.useSearch();
  return <BindingsList configuration={data} members={members} initialMember={member} />;
};
const Search = Schema.Struct({ member: Schema.optionalKey(Schema.String) });
export const Route = createFileRoute("/configuration/bindings/")({
  validateSearch: Schema.decodeUnknownSync(Search),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(configurationQuery()),
      context.queryClient.ensureQueryData(membersQuery()),
    ]),
  component: Bindings,
});
