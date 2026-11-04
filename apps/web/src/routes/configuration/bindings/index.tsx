import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CreateEntity } from "~/features/configuration/components/editor/create";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { configurationQuery } from "~/lib/configuration/queries";
import { Schema } from "effect";
import { membersQuery } from "~/lib/members/queries";
import { bindingCopy } from "~/features/configuration/strings";

const Bindings = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  const { data: members } = useSuspenseQuery(membersQuery());
  const { member } = Route.useSearch();
  return (
    <ConfigurationPage title={bindingCopy.title}>
      <CreateEntity key={member} kind="binding" initialMember={member} />
      <p>{bindingCopy.description}</p>
      <ul className="divide-y border-y">
        {data.bindings.map((binding) => (
          <li className="py-3" key={binding.name}>
            <Link
              to="/configuration/bindings/$binding"
              params={{ binding: binding.name }}
              className="text-primary hover:underline"
            >
              {binding.name}
            </Link>
            <p>
              {members.find(({ id }) => id === binding.member)?.login ??
                bindingCopy.unenrolledMember}{" "}
              · {binding.role} ·{" "}
              {binding.scope._tag === "Instance" ? bindingCopy.instance : binding.scope.project}
            </p>
          </li>
        ))}
      </ul>
    </ConfigurationPage>
  );
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
