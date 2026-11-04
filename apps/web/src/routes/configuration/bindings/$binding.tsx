import { useSuspenseQuery } from "@tanstack/react-query";
import { configurationQuery } from "~/lib/configuration/queries";
import { membersQuery } from "~/lib/members/queries";
import { bindingCopy } from "~/features/configuration/strings";
import { createFileRoute } from "@tanstack/react-router";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { entityKey } from "~/features/configuration/lib/entities";
const Binding = () => {
  const { binding } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  const { data: members } = useSuspenseQuery(membersQuery());
  const value = data.bindings.find((entry) => entry.name === binding);
  return (
    <ConfigurationPage title={binding} entity={entityKey("binding", binding)}>
      {value !== undefined && (
        <p>
          {members.find(({ id }) => id === value.member)?.login ?? bindingCopy.unenrolledMember} ·{" "}
          {value.role} ·{" "}
          {value.scope._tag === "Instance" ? bindingCopy.instance : value.scope.project}
        </p>
      )}
    </ConfigurationPage>
  );
};
export const Route = createFileRoute("/configuration/bindings/$binding")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(configurationQuery()),
      context.queryClient.ensureQueryData(membersQuery()),
    ]),
  component: Binding,
});
