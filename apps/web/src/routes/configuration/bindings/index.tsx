import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { configurationQuery } from "~/lib/configuration/queries";
import { bindingCopy } from "~/features/configuration/strings";

const Bindings = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return (
    <ConfigurationPage title={bindingCopy.title} createKind="binding">
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
              {bindingCopy.member} {binding.member} · {binding.role} ·{" "}
              {binding.scope._tag === "Instance" ? bindingCopy.instance : binding.scope.project}
            </p>
          </li>
        ))}
      </ul>
    </ConfigurationPage>
  );
};
export const Route = createFileRoute("/configuration/bindings/")({ component: Bindings });
